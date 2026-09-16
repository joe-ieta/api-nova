---
doc-version: 1.0.0
doc-status: active
doc-updated: 2026-09-16
---
# 安全交付验收证据索引（SEC-F4-01）

> Document status: Active evidence index; this document is an index, not a release sign-off.
> Contract: [安全任务规划](./security-development-task-plan.md)、[叶子任务划分](./active-work-package-breakdown.md)、[叶子状态](./active-work-package-execution-status.md)。
> Last reconciled: 2026-09-16；索引与划分文档的 45 个 SEC 叶子 ID 一一对应。

## 证据口径和版本

编制时远端代码基线为 `19546cf`；并行工作区仍有未提交改动，所以本页**不**把该 SHA 当成所有新专项的测试版本。任何后续验收记录都须附最终提交 SHA、锁文件摘要、平台、运行命令、退出码和原始日志。当前 `package-lock.json` 固定 MCP SDK 1.29.0，Server/Parser 包版本均为 1.7.0；这是检索基线，不是已发布部署版本。当前安全父包仍为 DONE 1、IN_PROGRESS 18、BACKLOG 3、DEFERRED 1；子项状态只以[叶子台账](./active-work-package-execution-status.md)为准。

本页使用四种证据级别：

| 标记 | 含义 |
| --- | --- |
| **历史执行** | 2026-09-06/08 的脚本结果，或 2026-09-14 的旧整合基线；可作回归线索，不能直接证明当前版本。 |
| **限定执行** | [安全执行台账](./security-development-execution-status.md)、[安全用例](../testing/runtime-security-audit-cases.md)或[第二批审计](../audits/2026-09-16-replanned-batch-2-evidence.md)明确记录的本地/合成/回环结果；只覆盖所列切片。 |
| **准备** | 合同、脚本或操作步骤存在，但目标版本/平台/环境矩阵没有完整运行结果。 |
| **待验收** | 无当前执行证据，或关键实现/依赖未完成。不得从相邻父包或旧日志推断通过。 |

`tmp/` 日志是本地临时证据，未保证随 Git 提交或发布包交付。以下“已有入口”只说明可追溯位置；脚本存在、构建通过或文档完成，均不自动提高子项状态。外部环境、PostgreSQL、Linux、真实身份提供方、生产部署及依赖在线审计保持各自未运行状态。

## A–C：身份、凭证和配置

| 叶子出口 | 已有入口/版本与环境 | 当前证据和未闭合项 |
| --- | --- | --- |
| SEC-A1-01 | [安全规划](./security-development-task-plan.md)、[模式用例](../testing/runtime-security-audit-cases.md)；SDK 1.29.0 | **准备**：Gateway/MCP 局部模式有历史用例；DTO、持久策略、UI、发布、运行逐路径矩阵待验收。 |
| SEC-A1-02 | [叶子台账](./active-work-package-execution-status.md)；无完整执行脚本 | **待验收**：Private Extension/local_process 标签与保存后运行行为仍待闭环。 |
| SEC-A2-01 | [Gateway policy 单测](../../packages/api-nova-api/src/modules/gateway-runtime/services/gateway-policy.service.spec.ts)、[运行安全用例](../testing/runtime-security-audit-cases.md) | **限定执行**：运行模式白名单、编译拒绝已有；缺失/未知/非法快照在发布、恢复、启动三个入口尚无当前联合结果。 |
| SEC-A3-01 | 无当前完整执行脚本 | **待验收**：reason/actor/expiry、生产双许可、到期 fail-closed 与审计未闭环。 |
| SEC-A4-01 | [数据库工具](../../packages/api-nova-api/scripts/database-tool.cjs)、[历史双库审计](../audits/2026-09-08-persistence-cleanup.md) | **历史执行/准备**：旧 43 表空库不可复用；第二批本地 SQLite 68 表零漂移只覆盖当时合成环境，当前整合 SHA 的初始化/重启仍须同一日志证明。 |
| SEC-A4-02 | [数据库工具](../../packages/api-nova-api/scripts/database-tool.cjs) | **待验收（环境）**：当前版本隔离 PostgreSQL 空库、重启、零漂移原始日志缺失；不得以 SQLite 或旧 43 表代替。 |
| SEC-B1-01 | [Gateway 凭证测试](../../packages/api-nova-api/src/modules/gateway-runtime/services/gateway-security.service.spec.ts)、[MCP 安全 smoke](../../packages/api-nova-server/scripts/runtime-security-audit-smoke.js) | **历史执行/待验收**：现有摘要/范围不等于统一 Protocol、Tool scope、Subject、Expiry、Actor 模型及两运行时解释一致。 |
| SEC-B1-02 | 无当前完整执行脚本 | **待验收**：多 Key 轮换族窗口、到期与撤销跨 Gateway/MCP 的下一请求证据缺失。 |
| SEC-B2-01 | [Parser JWT 安全测试](../../packages/api-nova-parser/src/audit/runtime-security-audit.test.ts)、[MCP 安全 smoke](../../packages/api-nova-server/scripts/runtime-security-audit-smoke.js) | **历史执行/待验收**：固定 RS256/ES256 与必需 claims 子集已有；允许算法、claims、clock skew 的保存和执行拒绝矩阵待完成。 |
| SEC-B3-01 | [列表授权](../../packages/api-nova-server/scripts/test-mcp-tool-list-authorization.cjs)、[执行授权](../../packages/api-nova-server/scripts/test-mcp-tool-execution-authorization.cjs) | **限定执行/待验收**：tools/list 34/34 和 handler 前二次授权已有；持久撤销、长连接权限传播与重连仍缺。 |
| SEC-B3-02 | [安全 smoke](../../packages/api-nova-server/scripts/runtime-security-audit-smoke.js)、[传输观测](../../packages/api-nova-server/scripts/test-mcp-transport-observability.cjs)；锁定 SDK 1.29.0 | **准备**：需以当前 SDK 固定 dispatcher、Session 身份和 scope 通知矩阵；旧 7 项跨进程用例不是该出口完整执行。 |
| SEC-C1-01 | [Loader/Schema 测试](../../packages/api-nova-parser/src/credentials/loader.spec.ts)、[配置规划](./security-development-task-plan.md) | **限定执行/准备**：header API Key/Bearer 及拒绝型 loader 有本机结果；批准凭据类型的逐项支持/拒绝、生命周期和作用域合同未定稿。 |
| SEC-C1-02 | 无覆盖全部批准类型的当前脚本 | **待验收**：须先按 C1-01 逐类型实现解析、注入、脱敏和拒绝；OAuth2 不属于本轮。 |
| SEC-C2-01 | [Linux 隔离操作说明](../testing/upstream-secret-provider-linux.md)、[Provider 脚本](../../packages/api-nova-parser/scripts/test-upstream-secret-provider.cjs) | **准备/待验收（环境）**：Windows 本机 53 项通过；30 个真实 Linux 文件权限场景尚未执行。说明中 82 通过只是预期值。 |
| SEC-C2-02 | [Provider 实现](../../packages/api-nova-parser/src/credentials/secret-provider.ts) | **待验收**：Windows Secret File ACL 适配及合法/越权文件拒绝无当前完整执行证据。 |
| SEC-C3-01 | [Registry 测试](../../packages/api-nova-parser/src/credentials/registry.spec.ts)、[安全台账 §18/20](./security-development-execution-status.md) | **限定执行/待验收**：Stable Read 和 manual reload/状态/审计已验证；Watch/debounce、坏文件保旧、并发重载、停机释放未完成。 |
| SEC-C3-02 | [可信映射测试](../../packages/api-nova-api/src/modules/runtime-assets/services/mcp-trusted-operation-bindings.spec.ts)、[Registry 测试](../../packages/api-nova-parser/src/credentials/registry.spec.ts) | **限定执行/待验收**：管理装配查询和候选核验不等于 Registry 配置 Source/Endpoint 的可信 DB 归属校验。 |
| SEC-C3-03 | 无当前跨进程 Registry 协调脚本 | **待验收**：需真实受管 child 链与跨进程 generation、失败/激活可观测证据。 |
| SEC-C4-01 | [Resolver 测试](../../packages/api-nova-parser/src/credentials/resolver.spec.ts)、[受管 child 测试](../../packages/api-nova-api/scripts/test-managed-mcp-handoff-preparation.cjs) | **限定执行/待验收**：纯 Resolver 与独立 child B1/B2 有结果；产品受管生命周期尚未接线，Gateway/MCP 继承/覆盖/None/Unresolved 联合门禁未验。 |

## D–E：数据面和 MCP

| 叶子出口 | 已有入口/版本与环境 | 当前证据和未闭合项 |
| --- | --- | --- |
| SEC-D1-01 | [请求头与网络边界合同](./security-header-network-boundary-contract.md) | **准备**：30 项矩阵仍为草案；请求/响应、多值、framing、保留字段和迁移例外需定稿。 |
| SEC-D1-02 | [Header 边界脚本](../../packages/api-nova-api/scripts/test-gateway-header-boundary.cjs)、[代理测试](../../packages/api-nova-api/src/modules/gateway-runtime/services/gateway-proxy-engine.credential.spec.ts) | **限定执行/待验收**：Connection/消费者头清理已有；业务 allowlist 与缓存、正文长度、响应字段及迁移兼容未完成。 |
| SEC-D2-01 | [缓存测试](../../packages/api-nova-api/src/modules/gateway-runtime/services/gateway-cache.service.spec.ts)、[流量控制测试](../../packages/api-nova-api/src/modules/gateway-runtime/services/gateway-traffic-control.service.spec.ts) | **限定执行/待验收**：缓存身份隔离已验证；真实请求 IP 层和 Anonymous 独立 bucket 仍缺。 |
| SEC-D2-02 | 同上；无全层组合执行记录 | **待验收**：Global/Runtime/Route/Credential/IP 顺序与拒绝归因不可由单层单测推导。 |
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
| SEC-F1-01 | [安全规划](./security-development-task-plan.md) | **准备**：Unsecured/Declared/Configured/Verified 与 OR/AND/Binding 转移表尚未定稿。 |
| SEC-F1-02 | [OpenAPI 提取测试](../../packages/api-nova-parser/tests/unit/security-extractor.test.ts)、[发布测试](../../packages/api-nova-api/src/modules/publication/services/publication.service.spec.ts) | **历史执行/待验收**：提取与发布各有局部覆盖；受保护未配置/未验证阻止发布、OR/AND 不弱化仍无当前执行证据。 |
| SEC-F2-01 | [安全台账 §10/14](./security-development-execution-status.md)、[UI 工作区](../../packages/api-nova-ui/src/modules/runtime-assets/RuntimeAssetDetail.vue) | **限定执行/待验收**：缺策略不误显示匿名已修；Consumer/Upstream 分区、Binding revision 与真实 Reload generation/恢复界面未闭合。 |
| SEC-F2-02 | 无申请/到期全链 UI 当前脚本 | **待验收**：匿名风险、原因、到期与服务端拒绝一致性依赖 A3。 |
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