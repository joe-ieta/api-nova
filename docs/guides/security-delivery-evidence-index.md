---
doc-version: 1.16.0
doc-status: active
doc-updated: 2026-09-21
---
# 安全交付验收证据索引（SEC-F4-01）

> Document status: Active evidence index; this document is an index, not a release sign-off.
> Contract: [安全任务规划](./security-development-task-plan.md)、[叶子任务划分](./active-work-package-breakdown.md)、[叶子状态](./active-work-package-execution-status.md)。
> Last reconciled: 2026-09-21；初版按当时45个SEC叶子编制；后续拆分ID及当前状态以统一叶子台账为准。

## 证据口径和版本

编制时远端代码基线为 `19546cf`；并行工作区仍有未提交改动，所以本页**不**把该 SHA 当成所有新专项的测试版本。任何后续验收记录都须附最终提交 SHA、锁文件摘要、平台、运行命令、退出码和原始日志。当前 `package-lock.json` 固定 MCP SDK 1.29.0，Server/Parser 包版本均为 1.7.0；这是检索基线，不是已发布部署版本。当前安全父包为 DONE 6、IN_PROGRESS 14、BACKLOG 2、DEFERRED 1；子项状态只以[叶子台账](./active-work-package-execution-status.md)为准。

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
| SEC-C1-01 | [Loader/Schema 测试](../../packages/api-nova-parser/src/credentials/loader.spec.ts)、[配置规划](./security-development-task-plan.md) | **限定执行/准备**：header API Key/Bearer 及拒绝型 loader 有本机结果；批准凭据类型的逐项支持/拒绝、生命周期和作用域合同未定稿。 |
| SEC-C1-02 | 无覆盖全部批准类型的当前脚本 | **待验收**：须先按 C1-01 逐类型实现解析、注入、脱敏和拒绝；OAuth2 不属于本轮。 |
| SEC-C2-01 | [Linux 隔离操作说明](../testing/upstream-secret-provider-linux.md)、[Provider 脚本](../../packages/api-nova-parser/scripts/test-upstream-secret-provider.cjs) | **准备/待验收（环境）**：Windows 本机 53 项通过；30 个真实 Linux 文件权限场景尚未执行。说明中 82 通过只是预期值。 |
| SEC-C2-02 | [Windows ACL证据](../audits/2026-09-21-windows-secret-acl.md) | **限定执行/DONE**：真实NTFS28/28、主任务复跑通过；仅本地驱动器，需要系统PowerShell/Add-Type，未替代Linux验收。 |
| SEC-C3-01 | [Watch交付证据](../audits/2026-09-21-registry-watch.md) | **限定执行/DONE**：Windows真实固定文件监听8/8、Parser凭据252/252、Gateway接线31/31；含坏文件保旧、并发管理员CAS、Nest关闭。DB归属、多进程及Linux不在此叶。 |
| SEC-C3-02 | [真实DB归属证据](../audits/2026-09-21-registry-db-ownership.md) | **限定执行/DONE**：Source/Endpoint未知或跨源拒绝，manual/watch/启动同校验，失败保旧；不代表激活后的自动DB撤销。 |
| SEC-C3-03 | 无当前跨进程 Registry 协调脚本 | **待验收**：需真实受管 child 链与跨进程 generation、失败/激活可观测证据。 |
| SEC-C4-01 | [Resolver 测试](../../packages/api-nova-parser/src/credentials/resolver.spec.ts)、[受管 child 测试](../../packages/api-nova-api/scripts/test-managed-mcp-handoff-preparation.cjs) | **限定执行/待验收**：纯 Resolver 与独立 child B1/B2 有结果；产品受管生命周期尚未接线，Gateway/MCP 继承/覆盖/None/Unresolved 联合门禁未验。 |

## D–E：数据面和 MCP

| 叶子出口 | 已有入口/版本与环境 | 当前证据和未闭合项 |
| --- | --- | --- |
| SEC-D1-01 | [Header合同1.0.0](./security-header-network-boundary-contract.md) | **政策定稿/DONE（DOC）**：双向allowlist、多值/framing、保留字段/缓存/迁移已选择；H01–H12执行待D1-02，F3网络仍提案。 |
| SEC-D1-02 | [Header 边界脚本](../../packages/api-nova-api/scripts/test-gateway-header-boundary.cjs)、[代理测试](../../packages/api-nova-api/src/modules/gateway-runtime/services/gateway-proxy-engine.credential.spec.ts) | **限定执行/待验收**：Connection/消费者头清理已有；业务 allowlist 与缓存、正文长度、响应字段及迁移兼容未完成。 |
| SEC-D2-01 | [独立限流证据](../audits/2026-09-21-independent-rate-limits.md) | **限定执行/DONE**：真实HTTP覆盖IP/匿名独立桶、暖缓存和伪造转发头；Gateway全套201/201。进程内计数，完整层级及多节点不在此叶。 |
| SEC-D2-02 | [真实HTTP组合证据](../audits/2026-09-21-layered-rate-limit-composition.md) | **限定执行/DONE**：六层组合、缓存计量、同主体轮换、冲突窗口与精确并发准入；单进程既有范围。 |
| SEC-E0-01 | [安全 smoke](../../packages/api-nova-server/scripts/runtime-security-audit-smoke.js)、[HTTP delivery](../../packages/api-nova-server/scripts/test-mcp-http-delivery.cjs)；SDK 1.29.0 | **历史执行/准备**：现行 Session/stdio/HTTP 基线有局部用例；Method、Header、错误与所有入口的当前锁定版本矩阵待验。 |
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
| SEC-F1-01 | [四态与发布门禁合同](./upstream-security-reconciliation-contract.md) | **政策定稿/DONE（DOC）**：继承/OR-AND/兼容/失效表固定，非发布门禁实现；F1-02依赖C1-02。 |
| SEC-F1-02 | [OpenAPI 提取测试](../../packages/api-nova-parser/tests/unit/security-extractor.test.ts)、[发布测试](../../packages/api-nova-api/src/modules/publication/services/publication.service.spec.ts) | **历史执行/待验收**：提取与发布各有局部覆盖；受保护未配置/未验证阻止发布、OR/AND 不弱化仍无当前执行证据。 |
| SEC-F2-01 | [分区与重载UI证据](../audits/2026-09-21-upstream-credential-management-ui.md) | **限定执行/DONE**：binding revision/进程Registry generation及失败刷新恢复，UI12+真实HTTP1+后端21；非浏览器点击或MCP完整凭证编辑。 |
| SEC-F2-02 | [匿名UI证据](../audits/2026-09-21-temporary-anonymous-ui.md) | **限定执行/DONE**：Gateway/MCP申请、到期/生产风险与拒绝显示，26/26和构建；无真实浏览器点击验收。 |
| SEC-F3-01 | [请求头与网络边界合同](./security-header-network-boundary-contract.md) | **准备**：DNS、连接、redirect、代理与内网例外政策仍是提案；单跳/零自动 redirect 不是 SSRF 完成。 |
| SEC-F3-02 | 同上；无完整网络拒绝执行脚本 | **待验收**：DNS 全集分类、地址绑定/peer、逐跳凭据重建与代理边界均未形成可执行防线和矩阵。 |
| SEC-F3-03 | [安全用例](../testing/runtime-security-audit-cases.md)、[受管通道脚本](../../packages/api-nova-api/scripts/test-managed-mcp-channel.cjs) | **限定执行/待验收**：局部脱敏与 IPC 无 argv Secret 有证据；完整 argv/log/错误/快照 Secret Scan、创建/更新/撤销审计可检索依赖产品 E1。 |
| SEC-F3a-01 | [安全台账 §6](./security-development-execution-status.md)、[锁文件](../../package-lock.json) | **历史执行/待验收**：2026-09-07 漏洞数已过时；当前可达性、在线公告、补丁/风险处置与签收无当前执行证据，不自动 audit fix。 |
| SEC-F4-01 | 本索引及上述 45 个叶子出口的逐项映射 | **限定执行已完成**：45个SEC叶子ID与任务划分逐项一致；索引核对不改变任一技术父包状态，也不自动使 F4-02 READY。 |
| SEC-F4-02 | [安全规划 §6/8](./security-development-task-plan.md)、[安全用例](../testing/runtime-security-audit-cases.md)、[发布准备清单](./release-readiness-checklist.md) | **待验收（环境）**：依赖 D2/E2/F1/F2/F3/F3a 的各自出口和目标环境授权；当前没有完整真实签收。 |

## 发布验收时必须补齐的证据包

SEC-F4-02 只在所有前置出口完成后对**同一个不可变构建**执行，不引用不同日期的局部“通过数”拼装通过率。签收记录至少保留：

1. 提交 SHA、锁文件摘要、制品摘要、Node/npm/SDK 版本、操作系统/架构、数据库引擎与版本、部署拓扑和开关配置（脱敏）。
2. Unit、Gateway Integration、MCP SDK/真实 child、双 Runtime、非法 Reload、撤销/过期、SSRF/逐跳与 Secret Leak Scan 的逐命令退出码、原始日志及失败留证；[SEC-01～INT-05](../testing/runtime-security-audit-cases.md)是历史案例清单，不是本版通过声明。
3. 同版 SQLite 初始化/重启零漂移与隔离 PostgreSQL 初始化/重启零漂移；Windows/Linux 权限、传输和多进程矩阵；真实 IdP/JWKS、代理/TLS、外部客户端的受控验收结果。环境不可得时明确“未运行”，不得填通过。
4. 当前锁文件的生产可达性依赖审计、处置或明确签收依据；匿名开关、Secret Provider 权限、审计保留/备份恢复、部署及回退演练的真实环境记录。
5. 每项的操作者、日期、环境、日志位置、结论和未关闭缺陷。日志须脱敏并限制访问，不收集真实完整 Secret 到证据包。

安全项目验收与生产投运还受[活跃包划分](./active-work-package-breakdown.md)中的 SEC-F4-02 和 OPS-01 分别约束。旧 43 表、Windows 合成回环、独立 child READY、文档索引或本地构建都不能替代这些出口。