---
doc-version: 1.62.0
doc-status: active
doc-updated: 2026-09-24
---
# 安全交付验收证据索引（SEC-F4-01）

> Document status: Active evidence index; this document is an index, not a release sign-off.
> Contract: [安全任务规划](./security-development-task-plan.md)、[叶子任务划分](./active-work-package-breakdown.md)、[叶子状态](./active-work-package-execution-status.md)。
> Last reconciled: 2026-09-24；索引按当前SEC叶子ID持续复核；后续拆分ID及当前状态以统一叶子台账为准。

## 证据口径和版本

当前同步基线为 `9cd8149`；并行工作区仍有未提交改动，所以本页**不**把该 SHA 当成所有新专项的测试版本。任何后续验收记录都须附最终提交 SHA、锁文件摘要、平台、运行命令、退出码和原始日志。当前 `package-lock.json` 固定 MCP SDK 1.29.0，Server/Parser 包版本均为 1.7.0；这是检索基线，不是已发布部署版本。当前安全父包为 DONE 9、IN_PROGRESS 13、BACKLOG 0、DEFERRED 1；子项状态只以[叶子台账](./active-work-package-execution-status.md)为准。

本页使用四种证据级别：

| 标记 | 含义 |
| --- | --- |
| **历史执行** | 2026-09-06/08 的脚本结果，或 2026-09-14 的旧整合基线；可作回归线索，不能直接证明当前版本。 |
| **限定执行** | [安全执行台账](./security-development-execution-status.md)、[安全用例](../testing/runtime-security-audit-cases.md)或[第二批审计](../audits/2026-09-16-replanned-batch-2-evidence.md)明确记录的本地/合成/回环结果；只覆盖所列切片。 |
| **准备** | 合同、脚本或操作步骤存在，但目标版本/平台/环境矩阵没有完整运行结果。 |
| **待验收** | 无当前执行证据，或关键实现/依赖未完成。不得从相邻父包或旧日志推断通过。 |

`tmp/` 日志是本地临时证据，未保证随 Git 提交或发布包交付。以下“已有入口”只说明可追溯位置；脚本存在、构建通过或文档完成，均不自动提高子项状态。外部环境、Linux、真实身份提供方、生产部署及依赖在线审计保持各自未运行状态；当前版本Windows隔离PostgreSQL已补证，见下列A4-02。

## A–C：身份、凭证和配置

| 叶子出口 | 已有入口/版本与环境 | 当前证据和未闭合项 |
| --- | --- | --- |
| SEC-A1-01 | [安全规划](./security-development-task-plan.md)、[模式用例](../testing/runtime-security-audit-cases.md)；SDK 1.29.0 | **准备**：Gateway/MCP 局部模式有历史用例；DTO、持久策略、UI、发布、运行逐路径矩阵待验收。 |
| SEC-A1-02（聚合旧ID） | [真实发布闭环](../audits/2026-09-21-auth-publication-loop.md)、[模式UI证据](../audits/2026-09-21-mcp-mode-ui-evidence.md) | **限定执行/DONE**：A/B1-B4/C/D各出口已闭合，父包A1经原条件复核DONE。CLI管理摘要effective仍unknown；真实运行结果不冒充在线探测。 |
| SEC-A2-01（聚合旧ID） | [Gateway恢复证据](../audits/2026-09-17-interruption-recovery-evidence.md)、[MCP入口矩阵](../audits/2026-09-21-mcp-rejection-matrix.md) | **限定执行**：A/B本机拒绝矩阵已完成；不能外推生产生命周期或完整安全签收。 |
| SEC-A3-01 | [真实CLI与HTTP闭环](../audits/2026-09-21-live-rotation-temporary-anonymous.md) | **限定执行/DONE**：持久策略、下一请求执行和真实生命周期已验；主机database模式/生产双许可边界见报告，不替代UI/长连接/生产交付。 |
| SEC-A4-01 | [9月17日恢复审计](../audits/2026-09-17-interruption-recovery-evidence.md) | **限定执行**：SQLite69实体/表、3迁移、重连0迁移/0漂移；不替代PG或历史升级。 |
| SEC-A4-02 | [隔离PG脚本](../../packages/api-nova-api/scripts/test-isolated-postgres-schema.cjs)、[本批证据](../audits/2026-09-21-isolated-postgres-schema.md) | **限定执行**：Windows PG16.10当前69实体/表、3迁移、重连0迁移/0漂移、持久化/API启动通过；非Linux/旧版本升级/PG故障恢复。 |
| SEC-B1-01 | [统一凭证证据](../audits/2026-09-21-unified-consumer-credentials.md) | **限定执行/DONE**：真实持久模型、Gateway/MCP同Key解释、受管Runtime匹配；不包含动态轮换/撤销传播，未新增UI字段表单。 |
| SEC-B1-02 | [真实CLI与HTTP闭环](../audits/2026-09-21-live-rotation-temporary-anonymous.md) | **限定执行/DONE**：持久策略、下一请求执行和真实生命周期已验；主机database模式/生产双许可边界见报告，不替代UI/长连接/生产交付。 |
| SEC-B2-01 | [JWT真实生命周期](../audits/2026-09-21-jwt-policy-lifecycle.md) | **限定执行/DONE**：参数保存、固定信任源、真实冷重开CLI签名矩阵与长连接有效截止；非在线热更新/真实身份提供方部署。 |
| SEC-B3-01 | [真实会话撤销](../audits/2026-09-21-persistent-session-revocation.md) | **限定执行/DONE**：Streamable/SSE既有长连接、scope变化、撤销/重连/DB重开拒绝2/2；非在途取消/异步权限通知。 |
| SEC-B3-02 | [SDK会话矩阵](../audits/2026-09-21-sdk-session-contract.md) | **限定执行/DONE**：11项新增、联合71/71，固定dispatcher/Session/通知边界；不升级SDK或实现权限广播。 |
| SEC-C1-01 | [类型、生命周期与作用域合同](./upstream-credential-types-contract.md) | **政策定稿/DONE（DOC）**：四类支持目标与拒绝类型、时间/Scope、F1兼容已冻结；C1-02代码仍待实现。 |
| SEC-C1-02 | [四类型与Scope验收](../audits/2026-09-22-credential-types-scope.md) | **已实现/DONE**：四类型、生命周期/Scope、Basic双引用、秘密拒绝和真实Gateway/显式single-hop；受管生产E1/F1门禁仍独立。 |
| SEC-C2-01 | [Linux 隔离操作说明](../testing/upstream-secret-provider-linux.md)、[Provider 脚本](../../packages/api-nova-parser/scripts/test-upstream-secret-provider.cjs) | **准备/待验收（环境）**：Windows 本机 53 项通过；30 个真实 Linux 文件权限场景尚未执行。说明中 82 通过只是预期值。 |
| SEC-C2-02 | [Windows ACL证据](../audits/2026-09-21-windows-secret-acl.md) | **限定执行/DONE**：真实NTFS28/28、主任务复跑通过；仅本地驱动器，需要系统PowerShell/Add-Type，未替代Linux验收。 |
| SEC-C3-01 | [Watch交付证据](../audits/2026-09-21-registry-watch.md) | **限定执行/DONE**：Windows真实固定文件监听8/8、Parser凭据252/252、Gateway接线31/31；含坏文件保旧、并发管理员CAS、Nest关闭。DB归属、多进程及Linux不在此叶。 |
| SEC-C3-02 | [真实DB归属证据](../audits/2026-09-21-registry-db-ownership.md) | **限定执行/DONE**：Source/Endpoint未知或跨源拒绝，manual/watch/启动同校验，失败保旧；不代表激活后的自动DB撤销。 |
| SEC-C3-03 | 无当前跨进程 Registry 协调脚本 | **待验收**：需真实受管 child 链与跨进程 generation、失败/激活可观测证据。 |
| SEC-C4-01 | [Resolver 测试](../../packages/api-nova-parser/src/credentials/resolver.spec.ts)、[受管 child 测试](../../packages/api-nova-api/scripts/test-managed-mcp-handoff-preparation.cjs) | **限定执行/待验收**：纯 Resolver 与独立 child B1/B2 有结果；产品受管生命周期尚未接线，Gateway/MCP 继承/覆盖/None/Unresolved 联合门禁未验。 |

## D–E：数据面和 MCP

| 叶子出口 | 已有入口/版本与环境 | 当前证据和未闭合项 |
| --- | --- | --- |
| SEC-D1-01 | [Header合同1.0.0](./security-header-network-boundary-contract.md) | **政策定稿/DONE（DOC）**：双向allowlist、多值/framing、保留字段/缓存/迁移已选择；H01–H12执行待D1-02，F3网络政策亦已定稿，执行未完成。 |
| SEC-D1-02A/B/C | [02A编译](../audits/2026-09-21-header-policy-compilation.md)、[02B双向流](../audits/2026-09-21-header-wire-execution.md)、[02C缓存](../audits/2026-09-22-header-cache-isolation.md) | **分阶段执行/DONE**：compiled路径真实HTTP与缓存隔离已通过；生产激活仍拒绝。 |
| SEC-D1-02D1 | 当前实现与专项测试 | **限定执行/DONE**：同一Registry快照的策略/凭据/代次/历史名接入不可变Prepared Exchange，5套118项通过；未启用生产v1。 |
| SEC-D1-02D2A | [迁移helper](../../packages/api-nova-api/src/modules/gateway-runtime/services/gateway-header-migration.ts)、[迁移测试](../../packages/api-nova-api/src/modules/gateway-runtime/services/gateway-header-migration.spec.ts) | **限定执行/DONE**：纯迁移契约/校验器覆盖具名legacy期限、未知字段与来源变更拒绝，3套57项通过；未接生产创建入口或持久化。 |
| SEC-D1-02D2B | [PublicationService](../../packages/api-nova-api/src/modules/publication/services/publication.service.ts)、[D1/F3合同](./security-header-network-boundary-contract.md) | **限定执行/DONE**：两新建入口持久写入v1草稿+来源、旧路由不回填；NOT_READY先于任何ACTIVE写，SQL.js重开，6套65项通过。 |
| SEC-D1-02D2C | [例外服务](../../packages/api-nova-api/src/modules/gateway-runtime/services/gateway-header-legacy-exception.service.ts)、[例外测试](../../packages/api-nova-api/src/modules/gateway-runtime/services/gateway-header-legacy-exception.service.spec.ts) | **限定执行/DONE**：显式登记/校验/撤销与持久墓碑，SQL.js 3套45项通过；未生产注册，PG JSONB CAS未实测。 |
| SEC-D1-02D2D | [联合迁移测试](../../packages/api-nova-api/src/modules/gateway-runtime/services/gateway-header-migration-joint.spec.ts)、[PG验收脚本](../../packages/api-nova-api/scripts/test-postgres-header-exception.cjs)、[隔离PG脚本](../../packages/api-nova-api/scripts/test-isolated-postgres-header-exception.cjs) | **限定执行/DONE**：SQLite联合snapshot/旧explicit grant/new v1重开及bad reload保旧；隔离PG并发CAS/重开/providerClosed/expiry/revoke并清理；4套49项及API构建通过。运行时legacy期限守卫未注册。 |
| SEC-D1-02D3 | [入口安装](../../packages/api-nova-api/src/common/gateway-ingress-bootstrap.ts)、[入口测试](../../packages/api-nova-api/src/common/gateway-ingress-bootstrap.spec.ts)、[产品main接线](../../packages/api-nova-api/src/main.ts) | **限定执行/DONE**：Nest/Socket.IO初始化后、listen前安装checkContinue/checkExpectation/upgrade；2套24项与API构建通过，生产v1仍受D2/D4门禁。 |
| SEC-D1-02D4A | [Legacy guard](../../packages/api-nova-api/src/modules/gateway-runtime/services/gateway-header-legacy-runtime.guard.ts)、[guard测试](../../packages/api-nova-api/src/modules/gateway-runtime/services/gateway-header-legacy-runtime.guard.spec.ts)、[HTTP矩阵](../../packages/api-nova-api/src/modules/gateway-runtime/services/gateway-header-legacy-runtime.http.spec.ts) | **限定执行/DONE**：纯guard与局部真实HTTP 37项通过；未接生产运行时。 |
| SEC-D1-02D4B | [Gateway模块](../../packages/api-nova-api/src/modules/gateway-runtime/gateway-runtime.module.ts)、[Proxy接线](../../packages/api-nova-api/src/modules/gateway-runtime/services/gateway-proxy-engine.service.ts)、[Legacy guard](../../packages/api-nova-api/src/modules/gateway-runtime/services/gateway-header-legacy-runtime.guard.ts) | **限定执行/DONE**：明确授权下未获有效例外旧路由503；5 files、HTTP/SQL.js+Runtime/DI 5套68项通过，cache/Resolver/upstream零绕过。 |
| SEC-D1-02D4C | [H01–H12矩阵](./security-header-network-boundary-contract.md) | **限定盘点/DONE**：14套223项及隔离PG CAS/reopen/expiry/revoke/noActivation通过；逐项证据为acceptanceComplete:false，H07冷启动与membership正式正向未闭环。 |
| SEC-D1-02D4D1 | [历史Store](../../packages/api-nova-parser/src/credentials/credential-header-history.ts)、[Store测试](../../packages/api-nova-parser/src/credentials/credential-header-history.spec.ts)、[Registry接线](../../packages/api-nova-parser/src/credentials/registry.ts) | **限定执行/DONE**：sync snapshot前可信Host Store/Registry单调CAS；3 files、12新增测试，Parser29套557项及build通过。 |
| SEC-D1-02D4D2 | [Ledger Entity](../../packages/api-nova-api/src/database/entities/gateway-header-history-ledger.entity.ts)、[Ledger Service](../../packages/api-nova-api/src/database/gateway-header-history-ledger.service.ts)、[SQLite迁移](../../packages/api-nova-api/src/database/migrations/1790000008000-GatewayHeaderHistoryLedgerSqlite.ts)、[PG迁移](../../packages/api-nova-api/src/database/migrations/1790000009000-GatewayHeaderHistoryLedgerPostgres.ts) | **限定存储/DONE**：CAS单调并集、4096上限及旧库冷重开；SQLite4套6项、API build与全新隔离PG zero-drift通过；不接Provider。 |
| SEC-D1-02D4D3 | [Provider bridge](../../packages/api-nova-api/src/modules/gateway-runtime/services/gateway-upstream-credential.providers.ts)、[bootstrap测试](../../packages/api-nova-api/src/modules/gateway-runtime/services/gateway-header-history-bootstrap.spec.ts)、[SQL.js冷启动脚本](../../packages/api-nova-api/scripts/test-sqljs-header-history-bootstrap.cjs)、[PG双进程脚本](../../packages/api-nova-api/scripts/test-isolated-postgres-header-history-bootstrap.cjs) | **限定执行/DONE**：稳定DB namespace，missing/corrupt ledger局部empty registry/HTTP503且Nest health200；SQL.js+隔离PG轮换→清空→冷启动后旧header剥离，2套31项与API build通过。 |
| SEC-D1-02D4D4 | [联合验收Spec](../../packages/api-nova-api/src/modules/gateway-runtime/services/gateway-header-history-acceptance.spec.ts)、[真实冷启动脚本](../../packages/api-nova-api/scripts/test-gateway-header-history-cold-restart.cjs)、[隔离PG脚本](../../packages/api-nova-api/scripts/test-isolated-postgres-header-history-bootstrap.cjs) | **限定执行/DONE**：SQL.js并发CAS、watch stop前后durable commit及迁移回滚不污染；4个API组合37项+Parser契约12项，双Node/HTTP SQLite与隔离PG H07全true并清理。H11 membership→v1仍未闭合。 |
| SEC-D1-H11A | Registry-source v1受控激活专项与构建 | **限定DONE**：16项真实Controller/Nest/HTTP/cache/SQL.js冷重启联合用例、strict helper 10项、Gateway+Publication 58 suites/778 tests及API build通过。全API首轮116 suites/1293 tests中115 suites/1292 tests通过，唯一process-manager.temporary-anonymous suite超时；单跑4/4在12.09s通过且未改测试。F1 Verified未接线，inline/legacy/unmigrated/unknown/unsafe仍fail-closed并保旧，无外部部署。 |
| SEC-D1-H11B | 生产H01–H12与缓存语义验收 | **限定DONE**：真实部署/回放/激活/Nest HTTP/cache 33场景，相关73 suites/1023 tests及API build通过；Range/If-*、gzip/identity字节、cache分区与直连/bypass已验。Proxy仅按validated chunked策略重建TE；SQL.js同秒精度stale按1050ms等待，不弱化guard。无真实外连，临时h11b日志不交付。 |
| SEC-D2-01 | [独立限流证据](../audits/2026-09-21-independent-rate-limits.md) | **限定执行/DONE**：真实HTTP覆盖IP/匿名独立桶、暖缓存和伪造转发头；Gateway全套201/201。进程内计数，完整层级及多节点不在此叶。 |
| SEC-D2-02 | [真实HTTP组合证据](../audits/2026-09-21-layered-rate-limit-composition.md) | **限定执行/DONE**：六层组合、缓存计量、同主体轮换、冲突窗口与精确并发准入；单进程既有范围。 |
| SEC-E0-01 | [Adapter当前矩阵](../audits/2026-09-21-mcp-adapter-contract.md) | **限定执行/DONE**：原始HTTP、锁定SDK会话及真实stdio60/60；方法405修复，不升级协议或替代E2完整安全验收。 |
| SEC-E1-01 | [受管交付草案](./managed-mcp-credential-handoff-plan.md) | **限定 DOC**：0.1.0 草案已交付，不是代码或安全启动验收。 |
| SEC-E1-01R | [受管交付草案 §9](./managed-mcp-credential-handoff-plan.md) | **限定 DOC**：0.2.0 技术审查冻结 02A/真实 child 必选项，不是方案外生产批准。 |
| SEC-E1-02A | [通道脚本](../../packages/api-nova-api/scripts/test-managed-mcp-channel.cjs)、[第二批审计](../audits/2026-09-16-replanned-batch-2-evidence.md) | **限定执行**：Windows 本机合成真实 Node child 私有 IPC 11/11、ProcessManager 3/3；不证明产品启动状态。 |
| SEC-E1-02B1 | [父端准备脚本](../../packages/api-nova-api/scripts/test-managed-mcp-handoff-preparation.cjs)、[第二批审计](../audits/2026-09-16-replanned-batch-2-evidence.md) | **限定执行**：固定 Registry、双 DB 快照及候选/环境核验 23/23；不证明 child 生命周期。 |
| SEC-E1-02B2 | [通道脚本](../../packages/api-nova-api/scripts/test-managed-mcp-channel.cjs)、[受管运行脚本](../../packages/api-nova-server/scripts/test-managed-runtime.cjs)、[第二批审计](../audits/2026-09-16-replanned-batch-2-evidence.md) | **限定执行**：独立 child 稳定重读、single-hop、监听后 READY，三脚本联合 47/47；仍不等于产品 Server 接线。 |
| SEC-E1-02C1 | [受管交付草案](./managed-mcp-credential-handoff-plan.md) | **待验收**：未验收生命周期草稿已撤回；生产启动/停止状态行为变更需明确授权后再实施，不能用 02A/B 结果代替。 |
| SEC-E1-02C2 | 无当前重启/失败/legacy 完整执行脚本 | **待验收**：依赖 C1；每次重启重备、timeout/exit/stop 状态及旧模式边界未验。 |
| SEC-E1-03 | [独立 child 脚本](../../packages/api-nova-server/scripts/test-managed-runtime.cjs) | **限定执行/待验收**：合成回环只证明 B2；产品受管路径的继承/覆盖/None、缺 Secret 零发送与零跳转未验。 |
| SEC-E1-04 | 无当前运行中撤销完整脚本 | **待验收**：版本更新/撤销生效时间和在途策略未定义并验证。 |
| SEC-E2-01 | [传输观测](../../packages/api-nova-server/scripts/test-mcp-transport-observability.cjs)、[安全 smoke](../../packages/api-nova-server/scripts/runtime-security-audit-smoke.js) | **历史执行/待验收**：取消、重连、回放隔离、撤销按已支持 transport 的当前联合矩阵待执行。 |
| SEC-E2-02 | 同上；[安全用例](../testing/runtime-security-audit-cases.md) | **待验收（环境）**：同一最终 SHA 的 Linux/Windows 分平台原始结果缺失；本机 Windows 结果不能外推。 |

## F：治理、供应链和交付

| 叶子出口 | 已有入口/版本与环境 | 当前证据和未闭合项 |
| --- | --- | --- |
| SEC-F1-01 | [四态与发布门禁合同](./upstream-security-reconciliation-contract.md) | **政策定稿/DONE（DOC）**：继承/OR-AND/兼容/失效表固定，非发布门禁实现；后续实现按F1-02A–F推进。 |
| SEC-F1-02A | [纯对账实现](../../packages/api-nova-api/src/modules/publication/security/upstream-security-reconciliation.ts)、[纯对账测试](../../packages/api-nova-api/src/modules/publication/security/upstream-security-reconciliation.spec.ts)、[发布门禁测试](../../packages/api-nova-api/src/modules/publication/security/upstream-security-publication-gates.spec.ts) | **限定执行/DONE**：声明保留、显式OR选择、AND不弱化、四态对账及发布/装配写入前拒绝，17套234项和API构建通过；不含可信Registry适配或耐久验证。 |
| SEC-F1-02B | [Binding评估实现](../../packages/api-nova-api/src/modules/publication/security/upstream-security-binding-evaluator.ts)、[Binding评估测试](../../packages/api-nova-api/src/modules/publication/security/upstream-security-binding-evaluator.spec.ts) | **限定执行/DONE**：可信Registry/Resolver Binding评估及opaque Provider epoch接入，5套57项和API构建通过；不含C的真实认证验证与耐久ledger。 |
| SEC-F1-02C1 | [证据Entity](../../packages/api-nova-api/src/modules/publication/security/upstream-authentication-evidence-prototype.entity.ts)、[挑战服务](../../packages/api-nova-api/src/modules/publication/security/upstream-authentication-challenge-prototype.ts)、[原型测试](../../packages/api-nova-api/src/modules/publication/security/upstream-authentication-challenge-prototype.spec.ts) | **限定原型/DONE**：真实挑战、磁盘SQL.js重开14/14，F1目录6套71项及API构建通过；未注册生产Entity/migration或接Transport/API。 |
| SEC-F1-02C2 | [生产证据Entity](../../packages/api-nova-api/src/database/entities/upstream-authentication-evidence.entity.ts)、[SQLite迁移](../../packages/api-nova-api/src/database/migrations/1790000006000-UpstreamAuthenticationEvidenceSqlite.ts)、[PostgreSQL迁移](../../packages/api-nova-api/src/database/migrations/1790000007000-UpstreamAuthenticationEvidencePostgres.ts) | **限定存储/DONE**：prototype kind隔离，SQLite+隔离PG 70表/5迁移冷启/重开/回退零漂移；12套83项、迁移9/9与API构建通过；未接生产挑战/Verified。 |
| SEC-F1-02C3a | [Context authority](../../packages/api-nova-api/src/modules/publication/security/upstream-security-context-authority.ts)、[联合测试](../../packages/api-nova-api/src/modules/publication/security/upstream-security-capabilities.spec.ts) | **限定纯模块/DONE**：与C3b/c合计4 files、27 tests、API security 8套105项及build通过；无DB/DI/readiness/生产Verified。 |
| SEC-F1-02C3b | [Challenge transport](../../packages/api-nova-api/src/modules/publication/security/upstream-authentication-challenge-transport.ts)、[联合测试](../../packages/api-nova-api/src/modules/publication/security/upstream-security-capabilities.spec.ts) | **限定纯模块/DONE**：受限transport与失败分类已验；transport不授予Verified，未接生产DI/readiness。 |
| SEC-F1-02C3c | [Proof authority](../../packages/api-nova-api/src/modules/publication/security/upstream-security-proof-authority.ts)、[联合测试](../../packages/api-nova-api/src/modules/publication/security/upstream-security-capabilities.spec.ts) | **限定纯模块/DONE**：proof与可信上下文绑定已验；未接生产evidence kind、消费者或Verified门禁。 |
| SEC-F1-02C3d | [生产Evidence Entity](../../packages/api-nova-api/src/database/entities/upstream-production-challenge-evidence.entity.ts)、[SQLite迁移](../../packages/api-nova-api/src/database/migrations/1790000010000-UpstreamProductionChallengeEvidenceSqlite.ts)、[PostgreSQL迁移](../../packages/api-nova-api/src/database/migrations/1790000011000-UpstreamProductionChallengeEvidencePostgres.ts)、[迁移测试](../../packages/api-nova-api/src/database/upstream-production-challenge-evidence-migration.spec.ts)、[Proof authority](../../packages/api-nova-api/src/modules/publication/security/upstream-security-proof-authority.ts) | **限定存储/DONE**：生产格式独立表、双库CHECK/迁移/注册与prototype隔离；16套120项，SQLite 72表/7迁移及隔离PG 72/7 zero drift；拒绝prototype/DB行，不代表生产Verified。 |
| SEC-F1-02C3e | [编排器](../../packages/api-nova-api/src/modules/publication/security/upstream-authentication-challenge-orchestrator.ts)、[编排测试](../../packages/api-nova-api/src/modules/publication/security/upstream-authentication-challenge-orchestrator.spec.ts) | **限定编排/DONE**：四阶段真实loopback→SQLite耐久重读→context/epoch重评→私有proof，10套123项及API build通过；DB记录不能重建proof，保存/绑定变化/迟到/撤销均拒绝。未接生产意图权威/DI/controller/publication。 |
| SEC-F1-02C3f | [Intent authority](../../packages/api-nova-api/src/modules/publication/security/trusted-challenge-intent-authority.ts)、[Authority测试](../../packages/api-nova-api/src/modules/publication/security/trusted-challenge-intent-authority.spec.ts) | **限定host-only/DONE**：2 files/24 tests，security目录10套146项及API build通过；所有拒绝场景0 transport/HTTP。未接DI/controller/seed/schema及实际session/tenant adapter，不代表生产Verified。 |
| SEC-F1-02C3G1 | 消费adapter与扩展authority/orchestrator fixtures | **限定DONE**：按source/endpoint/target/method/Binding消费真实能力，30 tests、security 11 suites/176及API build通过；不代表production gate已接线。 |
| SEC-F1-02C3G2 | 只读adapter实现与专项日志 | **限定DONE**：2 files、2 suites/43及API build通过；SQL日志仅SELECT、实体/evidence零变更且无新增loopback。canPublish恒false、未接生产入口。 |
| SEC-F1-02C3G3 | publication-member-transaction-writer实现与SQL.js专项 | **限定DONE**：2 files、1 suite/10项SQL.js及API build通过；publication记录同事务、部署副作用after commit。未注册生产入口、未验PostgreSQL。 |
| SEC-F1-02C3G4 | 有界executor专项与API构建 | **限定DONE**：3 suites/30 tests及API build通过；生产G2默认false且验证G3零调用，仅显式future-readiness fixture证明部分提交/后续继续。candidate只做host-owned同步swap且无await，未接异步Registry生产链，不能宣称production batch/candidate activation完整。 |
| SEC-F1-02C3G5 | Gateway proof consumer guard限定切片 | **WAIT_DEP**：独立guard与真实HTTP 3 suites/54 tests及API build通过，缺失/过期/范围不符proof在Resolver/cache前拒绝；但未注册module/runtime，缺生产issuer、同进程authority lifecycle与request-bound capability provider。不开放Verified，E1继续拒绝。 |
| SEC-F1-02C3G6 | 当前无MCP/child实时许可证据 | **WAIT_DEP**：依赖E3b/G1；实时许可、撤销与proof不序列化未验。 |
| SEC-F1-02D | 无当前统一发布结果证据 | **READY**：G2/G4依赖已闭合；preview、单批发布和激活共同结果及事务内context复核未验，G4限定完成不构成生产激活证据。 |
| SEC-F1-02E1 | [Gateway guard](../../packages/api-nova-api/src/modules/gateway-runtime/services/gateway-upstream-security-runtime.guard.ts)、[真实HTTP测试](../../packages/api-nova-api/src/modules/gateway-runtime/services/gateway-upstream-security-runtime.http.spec.ts) | **限定执行/DONE**：6 files，39套556项及13项真实HTTP SQL.js重校、API构建通过；不声明生产Verified。 |
| SEC-F1-02E2 | [Parser唯一规则](../../packages/api-nova-parser/src/security/upstream-security-reconciliation.ts)、[Transformer接线](../../packages/api-nova-parser/src/transformer/index.ts) | **限定执行/DONE**：标准HTTP门禁，6 files；Parser28套545项、API102套1116项、三构建及扩例7/7通过；不含Verified/custom handlers/E3 managed传播。 |
| SEC-F1-02E3a | [协调器](../../packages/api-nova-api/src/modules/servers/services/managed-child-security-lease-coordinator.ts)、[协调器测试](../../packages/api-nova-api/src/modules/servers/services/managed-child-security-lease-coordinator.spec.ts) | **限定原语/DONE**：2 files/7 tests；未注册、未接handoff或事件IPC。 |
| SEC-F1-02E3b | 当前无运行中传播证据 | **WAIT_DEP**：运行中更新前阻断、实时授权、事件IPC及在线撤销零联网未验。 |
| SEC-F1-02F | 无双运行时完整验收 | **WAIT_DEP**：依赖D/E3b/G5/G6；两runtime端到端、SQL.js/PostgreSQL重开、并发迟到与同revision Provider变化未验。 |
| SEC-F2-01 | [分区与重载UI证据](../audits/2026-09-21-upstream-credential-management-ui.md) | **限定执行/DONE**：binding revision/进程Registry generation及失败刷新恢复，UI12+真实HTTP1+后端21；非浏览器点击或MCP完整凭证编辑。 |
| SEC-F2-02 | [匿名UI证据](../audits/2026-09-21-temporary-anonymous-ui.md) | **限定执行/DONE**：Gateway/MCP申请、到期/生产风险与拒绝显示，26/26和构建；无真实浏览器点击验收。 |
| SEC-F3-01 | [请求头与网络边界合同§4](./security-header-network-boundary-contract.md) | **政策定稿/DONE（DOC）**：public/direct、精确限期内网例外、DNS/连接/跳转/撤销已冻结；代码F3-02未实现，零redirect仍不等于SSRF防护。 |
| SEC-F3-02A | [网络边界合同§4.1–4.2](./security-header-network-boundary-contract.md) | **限定DONE**：严格v1配置/URL/origin、完整IPv4/IPv6分类、mapped归一和精确例外纯compiler完成；静态表`iana-2025-10-09-conservative-v1`，更新须复核IANA差异并重跑边界回归。network专项165项、Parser 30 suites/722 tests及typecheck/build通过；不接DNS、真实发送或host续期/撤销，不能关闭F3。 |
| SEC-F3-02B1 | [网络边界合同§4.3](./security-header-network-boundary-contract.md) | **限定DONE**：真实UDP 26/26、Parser 31 suites/748 tests及typecheck/build通过；A/AAAA/CNAME有界全集、规范化去重、逐地址授权及混合/未分类/截断拒绝已有证据。仅产出DNS批准结果，无上游socket、peer或TLS证据。 |
| SEC-F3-02B2 | [网络边界合同§4.3](./security-header-network-boundary-contract.md) | **限定DONE**：≤8MiB Buffer固定IP单跳transport primitive以31专项、Parser 32 suites/779 tests及typecheck/build通过；真实HTTP/TLS/peer/代理陷阱与Windows Node24已有证据。未接Gateway/Transformer host，且不支持Readable/大体积流或逐跳撤销。 |
| SEC-F3-02B3a | [网络边界合同§4.3](./security-header-network-boundary-contract.md) | **限定DONE**：共享private verified connection与Readable stream以Parser 33 suites/817 tests、stream专项38、B2既有31及typecheck/build通过；真实24MiB双向、backpressure、授权前body零读取、peer/TLS/代理/取消/截断/early response/one-shot已验。首轮816/817仅为B1真实DNS后置复核50ms夹具负载失败，测试改为真实解析后受控时间，生产deadline不变；仍无Transformer/Gateway/child生产接线。 |
| SEC-F3-02B3b | [网络边界合同§4.3](./security-header-network-boundary-contract.md) | **限定DONE**：7文件，Parser 34 suites/838 tests、专项21、typecheck/build及diff-check通过；真实Resolver绑定Site/generation/revision（含None），同Snapshot WeakMap host policy与最终序列化URL，bounded≤8MiB JSON/string/Buffer，默认网络模式off且F1零发送；Registry/DNS/HTTP/TLS与clone/reload/伪造/变异负测已有证据。生产Gateway/managed child、Provider撤销epoch及audit桥未接。 |
| SEC-F3-02B3c | [网络边界合同§4.3](./security-header-network-boundary-contract.md) | **IN_PROGRESS**：Gateway可信route网络Provider/stream桥已开工；新网络模式默认off且缓存禁用，整操作版本固定、逐跳撤销和生产启用仍归F3C。 |
| SEC-F3-02C | [网络边界合同§4.3–4.5](./security-header-network-boundary-contract.md) | **待验收**：依赖B3b与B3c两条运行时桥；逐跳凭据、safe-read、整操作固定revision、撤销/取消、缓存隔离与拒绝审计未实现，生产启用不得提前。 |
| SEC-F3-02D | [网络边界合同§4.6及N01–N17](./security-header-network-boundary-contract.md) | **待验收**：依赖C；Gateway/Parser真实连接及Windows/Linux矩阵未执行。 |
| SEC-F3-03 | [安全用例](../testing/runtime-security-audit-cases.md)、[受管通道脚本](../../packages/api-nova-api/scripts/test-managed-mcp-channel.cjs) | **限定执行/待验收**：局部脱敏与 IPC 无 argv Secret 有证据；完整 argv/log/错误/快照 Secret Scan、创建/更新/撤销审计可检索依赖产品 E1。 |
| SEC-F3a-01 | [安全台账 §6](./security-development-execution-status.md)、[锁文件](../../package-lock.json) | **历史执行/待验收**：2026-09-07 漏洞数已过时；当前可达性、在线公告、补丁/风险处置与签收无当前执行证据，不自动 audit fix。 |
| SEC-F4-01 | 本索引及SEC当前叶子出口逐项映射 | **限定执行已完成/持续维护**：索引按当前99个SEC叶子或明确标注的聚合旧ID维护；ID/链接校验不改变技术父包状态，也不自动使 F4-02 READY。 |
| SEC-F4-02 | [安全规划 §6/8](./security-development-task-plan.md)、[安全用例](../testing/runtime-security-audit-cases.md)、[发布准备清单](./release-readiness-checklist.md) | **待验收（环境）**：依赖 D2/E2/F1/F2/F3/F3a 的各自出口和目标环境授权；当前没有完整真实签收。 |

## 发布验收时必须补齐的证据包

SEC-F4-02 只在所有前置出口完成后对**同一个不可变构建**执行，不引用不同日期的局部“通过数”拼装通过率。签收记录至少保留：

1. 提交 SHA、锁文件摘要、制品摘要、Node/npm/SDK 版本、操作系统/架构、数据库引擎与版本、部署拓扑和开关配置（脱敏）。
2. Unit、Gateway Integration、MCP SDK/真实 child、双 Runtime、非法 Reload、撤销/过期、SSRF/逐跳与 Secret Leak Scan 的逐命令退出码、原始日志及失败留证；[SEC-01～INT-05](../testing/runtime-security-audit-cases.md)是历史案例清单，不是本版通过声明。
3. 同版 SQLite 初始化/重启零漂移与隔离 PostgreSQL 初始化/重启零漂移；Windows/Linux 权限、传输和多进程矩阵；真实 IdP/JWKS、代理/TLS、外部客户端的受控验收结果。环境不可得时明确“未运行”，不得填通过。
4. 当前锁文件的生产可达性依赖审计、处置或明确签收依据；匿名开关、Secret Provider 权限、审计保留/备份恢复、部署及回退演练的真实环境记录。
5. 每项的操作者、日期、环境、日志位置、结论和未关闭缺陷。日志须脱敏并限制访问，不收集真实完整 Secret 到证据包。

安全项目验收与生产投运还受[活跃包划分](./active-work-package-breakdown.md)中的 SEC-F4-02 和 OPS-01 分别约束。旧 43 表、Windows 合成回环、独立 child READY、文档索引或本地构建都不能替代这些出口。