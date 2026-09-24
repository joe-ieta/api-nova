---
doc-version: 1.106.0
doc-status: active
doc-updated: 2026-09-24
---
# ApiNova 安全开发执行与状态记录

> Document status: Active execution ledger
> Last updated: 2026-09-21
> 范围：JWT/API Key/显式 Anonymous；MCP SDK 1.29 的 2025 Session 基线。OAuth2 与后续无状态协议升级延期。
> 本轮按依赖完成 C3 Stable Read 与 Gateway 配置激活：Parser 全量 342/342、Gateway 全量专项 123/123（含句柄检测）及 Parser/Server/API 构建通过；扩大回归发现的 4 项旧夹具失败已修复并保留原证据。文件配置现支持主机显式Watch及manual，受权管理Reload/状态API已验证；MCP/完整网络安全仍未闭环；凭据链证据与下一依赖见第18节；缓存身份边界见第19节；C3受权重载见第20节；D1请求头见第21节，可信映射见第22节；显式单跳共享Resolver与隔离回归见第23节；可信资产快照生成与提交整理见第24节；装配接线见第25节；单语句归属读取见第26节；发布信息并入同语句见第27节；上游跨源核验见第28节；最新激活版本防护见第29节。

> 2026-09-15 调度重排：父包原退出条件不变；当前细分、跨计划归属和下一队列见[工作包划分](./active-work-package-breakdown.md)，逐项状态见[子任务执行台账](./active-work-package-execution-status.md)。父包 IN_PROGRESS 不表示正在同时执行；文档子项完成不计为代码完成。

## 1. 状态与证据规则

DONE 必须满足该包的代码、测试、文档和安全退出条件；IN_PROGRESS 包括已有子集和本轮开发，不意味着依赖已闭合；BACKLOG 为尚未实施完整任务的部分；READY 为可开始的明确切片；DEFERRED 为本里程碑之外。

当前共 23 包：DONE=10、IN_PROGRESS=12、BACKLOG=0、DEFERRED=1。A2历史状态复核及本批B1/A3原退出条件已闭合。C1-C3 文件装载到 Gateway 激活已是经验证切片；IN_PROGRESS 的具体实现、剩余退出条件和依赖以第2节状态表及最新执行节为准，历史执行段落仅用于追溯。

## 2. 阶段任务包

| 任务包 | 需求/依赖 | 当前状态 | 现有实现与剩余退出条件 |
| --- | --- | --- | --- |
| TP-A0 | SEC-PROTO-01；无 | DONE | 保留范围和协议冻结；不升级协议或启用 OAuth2 |
| TP-A1 | SEC-A01；A0 | DONE | Gateway jwt/api_key/anonymous、MCP HTTP private_jwt/private_api_key/anonymous、stdio local_process；持久选择、UI标签、真实发布/失败保旧/冷恢复/真实请求均有对应证据，不迁移旧OAuth入口策略；不代表完整安全验收 |
| TP-A2 | SEC-A02；A1 | DONE | 缺失/未知策略拒绝和显式Anonymous可用，A2-01A/B已有证据；此次修正父状态滞后 |
| TP-A3 | SEC-A03；A2/B1 | DONE | reason/可信actor/expiresAt保存与冷重开，生产双许可，真实Gateway/MCP到期拒绝审计；UI归F2 |
| TP-A4 | 数据库基线；A0 | IN_PROGRESS | 当前PG/SQLite的69实体、4迁移空库/重连/零漂移已分别通过；本次关闭A4-02环境出口，父包基线/迁移管理按原退出条件核对，不从环境子项自动提升 |
| TP-B1 | SEC-B01；A2 | DONE | 统一持久模型、协议/Route/Tool Scope、同Subject多Key轮换及跨Gateway/MCP下一请求撤销；动态CLI需主机显式database来源 |
| TP-B2 | SEC-B02；A1 | DONE | 固定可信JWK/JWKS与issuer/audience已有；算法/必需claims/clock skew保存、启动、签名拒绝和SSE截止现已按原出口验收 |
| TP-B3 | SEC-B03；B1/B2/E0 | DONE | 持久逐请求撤销、Session主体绑定、Tool过滤/二次授权及SDK通知边界均有证据；B1/B2/E0依赖闭合，不承诺权限广播或取消已接纳请求 |
| TP-C1 | SEC-C01；A0 | DONE | 对象/JSON/YAML与四类型、生命周期/Scope、Site/Endpoint继承覆盖None及实际Method均已验；A0依赖闭合。F1对账及E1受管生产验收分别归原包，不倒挂为C1新增条件 |
| TP-C2 | SEC-C02；C1 | IN_PROGRESS | Env/File Provider 已用于 Registry，Gateway 显式配置激活链已贯通；本机契约历史 53 项通过，真实 Linux 权限 30 场景待补证，Windows Secret File ACL已完成C2-02原生验收，Linux环境出口待验 |
| TP-C3 | SEC-C03；C2 | IN_PROGRESS | Stable Read、manual及Watch/debounce、受权Reload/状态和代次冲突已验证；C3-01 Watch与C3-02 DB归属完成，C3-03多进程待验 |
| TP-C4 | SEC-C04；C3 | IN_PROGRESS | Gateway与显式MCP single-hop Resolver已验证；SEC-C4-01验收真实受管child执行及Unresolved门禁，依赖E1/F1；网络政策主归F3，不在C4复制实现 |
| TP-D1 | SEC-D01；C4 | DONE | H11A完成Registry-source v1受控激活；H11B沿RuntimeAssets deploy→plan/真实GatewayCandidateReplay→activate→Nest HTTP/cache以33场景闭合H01–H12，相关73 suites/1023 tests及API build通过。Range/If-*、gzip/identity、cache分区与直连/bypass已验，Proxy只按validated chunked策略重建TE；inline/legacy/unmigrated/unknown/unsafe仍fail-closed，F1 Verified未接线且无真实外连 |
| TP-D2 | SEC-D02；B1/B2/D1 | IN_PROGRESS | 身份化缓存、六层限流与匿名独立桶功能出口已通过D2-01/02；原父依赖B2/D1整体验收待闭合，不额外添加多节点验收门槛 |
| TP-E0 | MCP Adapter；A0 | DONE | 锁定SDK1.29.0 Streamable/SSE/stdio方法/Header/错误/版本/Session原出口验收，60/60；不改变协议或宣称完整E2安全签收 |
| TP-E1 | SEC-E01；B3/C4/E0 | IN_PROGRESS | 可信映射、管理侧装配/发布读取、跨源校验及旧候选guard已验；SEC-E1-01~04负责技术方案、真实child接线、argv秘密移除、端到端与运行中撤销；管理侧继续微修不替代出口 |
| TP-E2 | SEC-E02；E1 | IN_PROGRESS | 安全 smoke/跨进程/传输专项有历史证据；当前完整安全矩阵、撤销/取消/重连和平台组合未完成 |
| TP-F1 | SEC-F01；C4 | IN_PROGRESS | A/B/C1/C2/C3a–c/E1/E2及E3a完成；C3a–c为4 files/27 tests纯模块；C3d以独立生产表、双库CHECK/迁移/注册及16套120项限定完成，C3e以四阶段loopback/SQLite编排、10套123项及API build限定完成；C3f限定完成；C3g拆为G1–G6；G1 proof/authorization adapter以30 tests、security 11 suites/176及API build限定完成，G3单成员事务writer以2 files、1 suite/10项SQL.js及API build限定完成但未注册/未验PG；G2只读preview/readiness adapter以2 files、2 suites/43及API build限定完成，SQL仅SELECT、实体/evidence零变更、canPublish恒false且未接生产入口；G4有界executor切片以3 suites/30 tests及API build限定完成：生产G2默认false且G3零调用，future-readiness fixture仅证明部分提交/后续继续，candidate只做host-owned同步swap且无await；未接异步Registry生产链，不能宣称production batch/candidate activation完整。D READY；G5独立Gateway proof consumer guard与真实HTTP验收实施中，仅限Resolver/cache前proof拒绝，不开放Verified、不改Publication入口，共享Runtime生产接线待协调；G6 MCP/child实时许可等待；当前不接production gate，F1保护全部fail-closed，仍无生产Verified；E3a未注册/未接handoff，E3b及D/F等待 |
| TP-F2 | SEC-F02；A3/B1/C3/F1 | IN_PROGRESS | F2-01分区/真实generation重载恢复与F2-02临时匿名UI均完成；父依赖C3/F1未闭合，MCP完整凭证编辑/浏览器点击不在本批签收 |
| TP-F3 | SEC-F03；C4/D1/E1 | IN_PROGRESS | A、B1、B2及B3a/b/c均限定DONE。C1a纯authority与C5a纯失败审计限定DONE；C1b以Parser38套925项、定向2套42项及构建限定DONE，C1c以4源码文件、Gateway43套649项、真实HTTP/TLS62项及构建限定DONE，两侧固定同一opaque handle、Snapshot、凭据、epoch与总deadline/abort。生产仍默认关闭。C1d的D1以自身2套16项、Parser41套971项（含C2a）、typecheck/build及diff-check限定DONE；D2再拆为D2a可信committed ACTIVE route目录/生命周期事件与D2b默认关闭的Gateway生产装配；D3以5 Parser文件、专项20项、Parser42套991项、全量typecheck/build及diff-check限定DONE，source/default-off且缺providerEvidence永拒，WeakMap fixture非生产issuer，不含managed child/E3b与跨进程传播。D2a以SQL.js/旧快照2套42项、Gateway44套664项、API build及diff-check限定DONE；SQL.js dirty-read以同步export到独立query_only副本修复，PG未实测、整库复制成本和原候选暂态snapshot行为保留。D2b再拆b1 immutable host generation store、b2 Registry capture/opaque proof、b3 default-off Gateway/Parser host装配；b1以2个credentials文件、自身23项、Parser44套1077项及构建限定DONE，仅含内存有界材料/CAS/同步撤销到期，无env/file导入、生产issuer或Registry关联，JS string无物理擦除保证；b2 Registry capture/opaque proof仍IN_PROGRESS且缺专项证据；历史首次Parser仅31套801项执行、另14套因6处TS7006未运行且构建失败，类型修复后统一Parser45套1098项、typecheck/build、cleanup及diff-check全绿，但不替代b2专项。b3等待，D4等待b3/D3。外部Secret Manager、跨进程/E3b与目标环境验收归D4/F3D NEED_ENV。C2a以2个独立Parser文件、专项30项及相邻5套240项限定DONE；C2b再拆b1纯redirect chain state、b2逐跳真实transport、b3 Transformer显式host配置/生产入口；b1以2个network文件、专项63项、相邻5套303项、Parser44套1077项及构建限定DONE，纯模块不触网/不启用生产入口；b2再拆b2a rawHeaders唯一Location证据纯模块与b2b同一authority逐跳真实transport，b2a以2个network文件、自身21项、相邻3套115项、Parser45套1098项及构建限定DONE，首次TS7006失败保留历史；b2b READY、b3等待且默认single-hop；C4 READY，C3/C5b/C6按新依赖等待。真实Provider撤销事件桥、原子revision、生产启用、多进程传播、缓存恢复/retry及F3D环境矩阵未完成，父F3C/TP-F3保持IN_PROGRESS |
| TP-F3a | 供应链治理；独立 | IN_PROGRESS | 旧依赖审计只是历史快照；当前可达性、补丁兼容和风险需重审，不自动 audit fix/重大升级 |
| TP-F4 | 全量验收；D2/E2/F1/F2/F3/F3a | BACKLOG | 完整安全矩阵、依赖审计、Linux/Windows 和对外交付门禁未满足 |
| TP-G1 | OAuth2 独立里程碑 | DEFERRED | 只保留不可执行占位，不获取/刷新 Token，不提供授权服务器或 OAuth Discovery |

## 3. 本轮静态审查发现

| 发现 | 处理边界 | 源码 |
| --- | --- | --- |
| 非法 Gateway mode 落入 API Key 分支 | 正常编译有保护，但不覆盖所有运行时对象；本轮 A2 补强 | [authorize](../../packages/api-nova-api/src/modules/gateway-runtime/services/gateway-security.service.ts) |
| 缺失策略在 UI 显示匿名 | 与编译器拒绝语义矛盾；本轮 F2 纠正 | [RuntimeAssetDetail.vue](../../packages/api-nova-ui/src/modules/runtime-assets/RuntimeAssetDetail.vue) |
| 未清理动态 Connection 字段，trailer 拼写不一致 | 本轮 D1 修补，不宣称业务 Allowlist 完成 | [buildForwardHeaders](../../packages/api-nova-api/src/modules/gateway-runtime/services/gateway-proxy-engine.service.ts) |
| MCP 注册回调没有执行前二次授权 | 本轮覆盖主入口及库入口，保留 stdio 边界 | [主注册入口](../../packages/api-nova-server/src/tools/initTools.ts)、[库注册入口](../../packages/api-nova-server/src/lib/initTools.ts) |
| 托管 bearer/custom-header 秘密仍可进入 argv | E1/F3 真实待办，不能仅隐藏日志便宣称消除 | [server-lifecycle.service.ts](../../packages/api-nova-api/src/modules/servers/services/server-lifecycle.service.ts) |
| 实例 binding 不是动态凭证 Registry | C1 先冻结结构，C2~C4 单独实施 | [binding service](../../packages/api-nova-api/src/modules/runtime-upstream-bindings/services/runtime-upstream-bindings.service.ts) |
| 引用头之后还有旧 authManager 注入 | 可能覆盖同名头；C4/E1 仍需统一 Resolver 最终注入 | [Parser transformer](../../packages/api-nova-parser/src/transformer/index.ts) |
| 管理 JWT 固定默认密钥回退 | 已确认启动校验允许缺省；本轮移除签发/校验两端回退并共享启动拒绝校验，41/41 专项通过，真实配置未读取或修改 | [JwtStrategy](../../packages/api-nova-api/src/modules/security/strategies/jwt.strategy.ts) |
| 认证模式缺身份仍可构造缓存键 | 本轮已关闭缓存服务纵深防御缺口：缺失/非法/模式不匹配身份跳过读写，41项专项通过；不替代主链鉴权 | [GatewayCacheService](../../packages/api-nova-api/src/modules/gateway-runtime/services/gateway-cache.service.ts) |
| binding 版本保护/审计范围有限 | 事务读后比较不是已验收跨进程 CAS；safeAudit 不等于配置/审计原子提交 | [binding service](../../packages/api-nova-api/src/modules/runtime-upstream-bindings/services/runtime-upstream-bindings.service.ts) |

## 4. MCP 协议与授权事实

- 保持 SDK 1.29 的 2025 Session 基线；后续无状态协议和 OAuth2 均延期。
- 逐请求认证、Session callerId 绑定、SSE 主体检查与事件回放隔离已有；同主体续签延续 Session 不等于跨主体放行。
- 环境 API Key 每请求检查及 JWT 签名/到期检查不证明持久撤销、跨进程即时传播或长连接即时撤销。
- Private Extension 不发布 OAuth Metadata。Discovery 在合法 Host/Origin 下返回不支持，challenge 不带虚假 resource_metadata。
- stdio 不套 HTTP JWT；local_process 是信任边界说明，当前 anonymous 审计值不是已新增本地身份枚举。
- runtime-http-agent 是物理尝试审计，不是业务 SSRF 防线；Webhook 目的地防护不能外推为所有上游的 DNS/连接/重定向复核。

## 5. 历史证据与当前未验证边界

| 日期/范围 | 已有证据 | 不能据此宣称 |
| --- | --- | --- |
| 2026-09-07 | A0 范围冻结、首批认证/JWT/DTO/多运行时专项 | 所有安全功能已完成或尚未开发 |
| 2026-09-08 | Parser 8 套件/30 例、API 45 套件/237 例、Server 6 组；SQLite/真实本地 PG 各 43 表及 API 启动；7 项安全跨进程通过 | 当前 schema 仍为 43 表；当前整合版本全量安全/数据库验证完成 |
| 2026-09-14 可观测性整合 | 三包构建 PASS、Parser 103、MCP 53、API 联合 548 | 安全全矩阵、业务 SSRF、Secret Registry、UI 或生产部署通过 |
| 上一轮安全复核/开发 | 四项构建及本轮专项复验通过，精确范围和日志见第 11 节 | 仅关闭本轮验证阻塞，不新增任务包 DONE，不宣称无漏洞 |

[双库清理审查](../audits/2026-09-08-persistence-cleanup.md)已解除旧 PG 凭据阻塞，但本轮未连接数据库。Linux、生产配置、备份恢复和当前空库矩阵仍单独验收。

[安全验收用例](../testing/runtime-security-audit-cases.md)保留可执行入口；[历史归档](../archive/summaries/security-2026-09-14/README.md)保留旧计划、原状态、原审计和验收全文。历史专项可能重叠，不能与可观测性计数累加。

## 6. 供应链风险时效

2026-09-07 历史结果：全量 1 Critical/24 High/29 Moderate/3 Low，生产 10 High/21 Moderate。这不是当前漏洞数，也不意味着风险关闭；本轮未联网执行依赖审计。

| 历史关注项 | 后续要求 |
| --- | --- |
| MCP Inspector 开发链 | 确认不进入生产包；重大升级重新确认兼容性，不照搬旧修复版本建议 |
| Nest/Express/Multer/qs | 当前生产可达性与兼容补丁，配套请求体/参数/上传回归 |
| fast-uri/ip-address | 与 IPv4/IPv6、DNS/重定向和业务 SSRF 验收联动 |
| js-yaml | YAML 凭证解析上线前重审依赖和拒绝型校验；本轮纯对象契约不新增 YAML 解析 |
| socket.io-parser/nanoid/postcss 等 | 按当前锁文件重新审计，记录修复或风险接受依据 |

获准后运行 npm audit --json 与 npm audit --omit=dev --json；不自动 npm audit fix，不擅自接受重大升级或风险豁免。

## 7. 本轮开发与后续顺序

本轮三个切片源码已写入，以下是实际实现回执，不是构建或运行验收：

- Gateway authorize 在认证上下文变更及凭证查询前精确接受 jwt/api_key/anonymous；非法或缺失 mode 返回固定 503 / gateway_auth_policy_invalid，保留 internal Anonymous 转 JWT 行为。
- Header 转发新增标准 trailer 和 Connection 声明字段的大小写无关清理，可信 Env 头仍后置注入；UI 缺策略显示未配置（阻止发布），不新增或替代发布门禁。
- MCP 新增执行检查封装，主注册和库的 File/URL/Spec 三个入口均在 handler 前复验当前 Streamable/SSE 上下文的 scope。显式 Anonymous 网络上下文也不绕过规则；stdio 或无上下文调用不新增 HTTP 鉴权，也不创造身份。
- Parser 导出 validateUpstreamCredentialBindings，接受已解析对象，返回独立深冻结候选；未配置/none/引用分别规范化为 inherit/none/reference。严格字段、危险键、循环/访问器、引用、重复选择器、头名和规模边界校验，错误仅固定代码。
- C1 当前仅 Header apiKey/bearer，所有环境 reference-only。Basic、CustomHeader、Query、Inline Secret 和外部 Provider 被拒绝；不解析 YAML/JSON 文本，不读取文件/环境秘密，不联网、Watch 或激活。
- C1 当前也拒绝百分号编码路径、通配 Host 和 Endpoint 同时声明 ID 与 Method/Path。资产归属、真实 Host/DNS、文件权限、秘密可解析性及 ID/路径是否指向同一 Endpoint，仍是后续 Registry/Resolver 的责任。

本节保留上一轮开发记录，第 11 节为对应复验结果，第 9 节为首次失败证据。本轮新增实现见第 12 节，尚未构建或测试；任务包不新增 DONE。


| 切片 | 生产文件范围 | 状态与验收要求 |
| --- | --- | --- |
| Gateway fail closed / UI / 逐跳头 | gateway-security.service.ts、gateway-proxy-engine.service.ts、RuntimeAssetDetail.vue | IN_PROGRESS；未知 mode 携带有效 Key 仍拒绝、无查询副作用、正常模式不变；Connection 动态字段清理 |
| MCP 执行前 scope | tools/initTools.ts、lib/initTools.ts、tools/runtime-security.ts | IN_PROGRESS；入口后规则收紧仍拒绝、handler 零执行、正常调用和 stdio 不受误伤；不等于 list/撤销闭环 |
| C1 纯配置契约 | credentials/types.ts、credentials/schema.ts、Parser src/index.ts | IN_PROGRESS；严格结构/未知字段/引用/重复和边界校验，无 I/O、Secret 解析、YAML/Watch/网络；完整凭证类型待补 |

本轮已获准补充专项、修正及构建回归；首次失败日志全部保留，未关闭类型检查或降低安全断言。仅初始化测试自有隔离 SQLite 并启停测试子进程，未操作业务数据库或执行生产迁移、环境秘密变更、业务服务启停、部署及远端推送。

上一轮拒绝边界已按第 11 节复验。本轮推进 C1 文本加载、C2 Provider 与 B3 tools/list；新增实现仍需独立验证。随后按依赖完成 C1/C2 剩余范围、C3 Registry、C4 Resolver，并继续 B1/B2、撤销、E1 CLI 秘密治理、F1/F2/F3 与最终 F4 验收。

## 8. 可观测性协同

保留远端 OBS-TP11/12 的事件、Outbox 和 Webhook 闭环，不重复开发。安全剩余与 OBS-TP15 身份审计/旧消费者、TP13 实时撤权、TP06/16 平台矩阵、TP10/14 存活及治理协同。

投递 14 天/事件到期上限与 FR-10 的 30 天目标差异仍归 OBS-TP14；API27/28 policies、Socket.IO、真实存活未完成。详见[可观测性剩余清单](./runtime-observability-completion-review.md)。

## 9. 首次验证记录（历史失败，已由第 11 节复验更新）

> 以下保留首次执行时的失败与待确认状态，不代表当前阻塞；授权修正后的结果以第 11 节为准。

用户已授权补充专项、运行构建与回归。以下为实际首次结果，不是预期结果；未关闭类型检查，也未使用旧 dist 代替当前源码。

| 范围 | 实际结果 | 证据 |
| --- | --- | --- |
| 管理 JWT 默认密钥拒绝 | 1 套件、41/41 通过 | tmp/security-2026-09-14-management-jwt-tests-171911.log |
| Parser 构建 | 失败，TS2322 | tmp/security-2026-09-14-parser-build.log |
| Parser 全回归 | 12 套件通过、1 套件启动失败；已执行 119/119 通过，整体仍失败 | tmp/security-2026-09-14-parser-tests.log |
| Gateway 定向回归 | 2 套件通过、5 套件启动失败；已执行 10/10 通过，整体仍失败 | tmp/security-2026-09-14-gateway-tests.log |
| UI 构建 | vue-tsc 失败，未进入 Vite 构建 | tmp/security-2026-09-14-ui-build-171527.log |
| Server/API 构建、MCP 回归 | 依赖未就绪，未执行；MCP 专项脚本已编写 | 不能登记通过 |

共同阻塞为 [credentials/schema.ts](../../packages/api-nova-parser/src/credentials/schema.ts) 第 246 行 TS2322：normalizedMatch.scheme 被推断成 string，不能赋值给 http/https 联合类型。C1 新套件和五个 Gateway 套件没有进入运行，119 和 10 不能解释为它们已验收。已报告用户，类型修正与受影响重跑等待确认；不以放宽类型或断言掩盖错误。

新增/扩展专项：[C1 结构校验](../../packages/api-nova-parser/src/credentials/schema.test.ts)、[Gateway mode](../../packages/api-nova-api/src/modules/gateway-runtime/services/gateway-security.service.spec.ts)、[Gateway Header](../../packages/api-nova-api/src/modules/gateway-runtime/services/gateway-proxy-engine.credential.spec.ts)、[MCP 执行授权](../../packages/api-nova-server/scripts/test-mcp-tool-execution-authorization.cjs)、[管理 JWT](../../packages/api-nova-api/src/modules/security/utils/management-jwt-secret.spec.ts)。

## 10. 本轮独立推进：管理 JWT 安全默认值

已确认旧启动 Schema 将 JWT_SECRET 设为可选，签发与校验两端均存在固定回退。现新增 [requireManagementJwtSecret](../../packages/api-nova-api/src/modules/security/utils/management-jwt-secret.ts)，同时用于启动 Schema、SecurityModule 和 JwtStrategy；缺失、短于 32 字符、固定回退值、空白或控制字符被拒绝，错误不回显输入。专项 41/41 通过，但未替代 API 整体构建或真实签发/登录集成验收。

运行环境需要显式配置至少 32 字符、无空白/控制字符的随机 JWT_SECRET。此密钥只用于管理 API 自身 Token，不是 Runtime 外部 JWT/JWKS、消费者 Key、上游 Secret 或 Webhook 密钥。没有读取、生成、替换或输出真实密钥；不合格配置将拒绝启动，而不是隐式使用固定默认值。

后续取得修正许可后，先修复共享类型，再按 Parser -> Server -> API 的依赖顺序重建，并重跑 Parser/Gateway/MCP 和 UI 验证；保留首次失败证据。全包状态维持 IN_PROGRESS，不新增 DONE。

## 11. 2026-09-14 上一轮授权修正与最终复验

> 本节描述新增 C1/C2/B3 实现之前的已验证代码，不覆盖第 12 节的新代码。

本轮验证范围全部通过，但任务包验收范围没有扩大。23 个安全任务包仍为 DONE 1、IN_PROGRESS 15、BACKLOG 6、DEFERRED 1；不将局部能力或专项通过记为整个任务包闭环。

### 11.1 最终结果

| 范围 | 最终结果 | 证据 |
| --- | --- | --- |
| Parser 构建 | 通过 | `tmp/security-2026-09-14-parser-build-rerun-172524.log` |
| Server 构建 | 通过 | `tmp/security-2026-09-14-server-build-rerun-172604-344.log` |
| API 构建 | 通过 | `tmp/security-2026-09-14-api-build-rerun-172703.log` |
| UI 类型检查与 Vite 构建 | 通过，未执行浏览器自动化 | `tmp/security-2026-09-14-ui-build-rerun-172552.log` |
| Parser Jest | 13 套，218/218；包含 C1 新增 99 项 | `tmp/security-2026-09-14-parser-tests-rerun-20260914-172608-794.log` |
| Gateway 与管理 JWT Jest | 8 套，106/106；包含管理 JWT 41 项，不重复累计 | `tmp/security-2026-09-14-gateway-tests-rerun-173603010.log` |
| MCP 执行前授权 | 20/20 | `tmp/security-2026-09-14-mcp-execution-tests-rerun-172755-087.log` |
| MCP HTTP、Transport、HTTP delivery、STDIO | 分别 15、15、11、12 项，共 53/53；另有 3 个 smoke 退出码为 0 | `tmp/security-2026-09-14-mcp-tests-rerun-172649-375.log` |
| 真实 API/MCP 测试子进程集成 | 7/7；3 次上游调用、4 次回环 HTTPS JWKS 读取 | `tmp/security-2026-09-14-integration-v2-rerun-173145.log` |
| API 可观测性联合回归 | 31 个文件，547/547，零失败、零取消、零跳过；排除真实 PostgreSQL 专项 | `tmp/security-2026-09-14-observability-joint-shared-key-20260914-174929-844.log` |

跨进程集成使用测试自有隔离 SQLite、回环 TLS/JWKS 和真实 API/MCP 测试子进程，包含真实管理登录、受保护调用者清单和当前 v2 终态调用记录；不代表业务数据库、外部身份提供方或生产部署验收。API 可观测性单文件先行复验为 2/2，日志为 `tmp/security-2026-09-14-observability-integration-env-rerun-174909-998.log`。

### 11.2 修正内容与失败证据

- Parser 为凭证站点匹配候选补充 `UpstreamCredentialSite['match']` 类型注解，修正 `scheme` 的推断错误；未放宽值校验、使用不安全断言或绕过类型检查。
- MCP 专项改为替换实际转换实现模块，避免向只读 barrel 导出 getter 赋值；20 个安全断言保留。
- Gateway 两份旧审计夹具改用真实入口观察器与规范化终态记录，区分 Gateway 入口和物理上游调用，等待审计刷新后读取与清理。
- 跨进程夹具增加测试专用审计 flush/ACK，读取完整的 `calls-v2-*.jsonl`，按终态上游调用检查唯一 invocation、started 对应关系、身份和完整 payload；所有阶段仍执行秘密泄漏断言。
- 可观测性模块夹具在导入 `AppModule` 前设置进程级测试 JWT 密钥，Schema 配置、注入配置和签名使用同一随机测试密钥，完成后恢复环境；不恢复默认密钥，不削弱 401/200 认证断言。

首次类型错误记录见第 9 节。下列失败日志保留，不以最终通过覆盖：

| 历史尝试 | 当时结果 | 日志 |
| --- | --- | --- |
| MCP 新专项首次重跑 | 测试替换只读导出失败 | `tmp/security-2026-09-14-mcp-execution-tests-rerun-172630-708.log` |
| Gateway 首次重跑 | 4 个旧审计夹具失败 | `tmp/security-2026-09-14-gateway-tests-rerun-172615023.log` |
| 跨进程首次重跑 | 前 6 项通过，最后读取旧格式审计文件失败 | `tmp/security-2026-09-14-integration-rerun-172703.log` |
| 可观测性联合首次 | 547 项，546 通过；缺少 JWT 校验夹具配置 | `tmp/security-2026-09-14-observability-joint-20260914-173936-531.log` |
| 可观测性联合第二次 | Node 报告 548 项，含文件级失败；进程 JWT 初始化未补齐 | `tmp/security-2026-09-14-observability-joint-rerun-20260914-174111-422.log` |
| 可观测性联合第三次 | 547 项，546 通过；认证请求返回 401 | `tmp/security-2026-09-14-observability-joint-final-20260914-174408-307.log` |
| 可观测性共享密钥首次单文件 | 首例通过，文件级进程退出失败 | `tmp/security-2026-09-14-observability-integration-key-rerun-174822-451.log` |

联合运行的文件清单记录在最终日志中。当前 547 项不替换其它日期的历史 548 项证据，也不将文件级失败计数当作新增功能用例。最终 Gateway 审计专项的 health 差分无新增写入/manifest/drop 失败且 pendingWrites 为 0；这不能反推历史警告都由清理竞争引起。

### 11.3 未完成与未验证边界

- C1 当前仍为纯对象凭证配置类型与校验器；YAML/JSON 文本入口、完整凭证类型未完成，C2 FileProvider、C3 Registry/reload、C4 Site/Endpoint Resolver 仍为 BACKLOG。
- B1 统一身份/凭证及撤销、B2 可配置 JWT claims/算法/时钟偏差、B3 tools/list 过滤与统一撤销仍未完成。
- MCP 执行前检查重新读取 scope 规则，使用已认证请求上下文；不重新验证凭证、刷新主体权限或终止已进入 handler 的调用。拒绝审计沿用 `failureStage: admission`，不能仅据此区分入口拒绝与二次拒绝。
- MCP 新专项使用转换层注入夹具，不代表完整 File/URL 解析链路；stdio/无请求上下文不新增 HTTP 身份。既有 Windows 16 MiB streamable cork/uncork 3 秒边界仍保留，比较测试通过不等于该边界恢复。
- Gateway Header 过滤不是完整业务白名单，未覆盖多 attempt 重试/重定向；UI 修正仅改变未配置策略的展示，不新增发布门禁。
- E1 CLI 秘密治理、F1 安全四态与 OR/AND、F2 完整 UI、F3 业务 SSRF/审计/秘密扫描、F3a 依赖审计、F4 完整平台与部署矩阵仍按任务表推进。
- 本轮未运行真实 PostgreSQL、联网依赖审计、Linux/跨平台全矩阵、浏览器自动化、真实外部发送或部署。不重开已有 PostgreSQL 历史证据结论，也不将本轮 SQLite 集成等同于零漂移或 PostgreSQL 验收。

## 12. 2026-09-14 首批并行开发记录

> 本节记录首批实现时的范围；之后的验证与 C3 开发进展以第 13、14 节为准。

本轮用户要求继续按计划开发，尚未授权新增构建或专项测试。本节只记录实际写入的生产代码及设计边界，不新增测试通过数量，不以第 11 节的旧结果验收当前新增代码。

当前 23 个任务包为 DONE 1、IN_PROGRESS 16、BACKLOG 5、DEFERRED 1。仅 TP-C2 从 BACKLOG 进入 IN_PROGRESS；TP-C1、TP-B3 保持 IN_PROGRESS，没有新增 DONE。

### 12.1 C1：安全 JSON/YAML 文本入口

新增 `packages/api-nova-parser/src/credentials/loader.ts`，公共入口为：

```ts
parseUpstreamCredentialBindings(
  text: string,
  format: UpstreamCredentialTextFormat,
): UpstreamCredentialBindingsCandidate
```

- `UpstreamCredentialTextFormat` 为 `'json' | 'yaml'`；复用现有 js-yaml 的 load/JSON_SCHEMA，不新增依赖。
- 输入上限 1 MiB UTF-8，拒绝未配对 UTF-16 代理字符；解析深度上限 32、解析事件节点上限 60000，之后继续接受原 schema 的更严格限制。
- JSON 先检查 JSON 语法，再检查重复键和解析预算；YAML 拒绝重复键、多文档、指令、警告及危险键/合并键。
- YAML 采用保守子集，预先拒绝原文中的 `!`、`&`、`*`，包括引号和注释中的这些字符。合法字符串需要这些字符时应使用 JSON，不宣称支持完整 YAML。
- 所有成功结果交给 `validateUpstreamCredentialBindings`，返回独立、深冻结候选；不读取文件、环境或网络，不解析秘密、不激活运行时。
- 文本错误只暴露静态错误码，不返回原始解析异常、文本片段或 cause。现有 header apiKey/bearer 类型边界不变，完整凭证类型仍未完成。

### 12.2 C2：独立 Env/File Provider

新增 `packages/api-nova-parser/src/credentials/secret-provider.ts`，由 Parser 公共出口导出：

```ts
createUpstreamSecretProvider(
  description: UpstreamSecretProviderDescription,
): UpstreamSecretProvider
// provider.resolve(key: string): Promise<string>
```

- 构造时无秘密读取和文件 I/O。后续 Registry 负责将 `providerId:key` 拆分，本接口只接收 provider 内的 key；本轮没有实现 Registry、watch/reload、缓存或最终 Header 注入。
- Env 只按显式大写环境变量名读取单个值，不展开表达式，不打印秘密；现有 `env-headers` 适配器保持原样。
- File 支持根目录下的相对多级路径，拒绝绝对 key、空路径段、`.`、`..`、反斜杠、冒号、百分号编码等；key 上限 512 UTF-8 字节、最多 16 段，秘密上限 8192 UTF-8 字节。
- Linux 文件读取检查普通文件、单链接、当前有效用户所有权、owner-only 文件/根目录及子目录权限；拒绝符号链接以及非可信用户可写的祖先目录，因而不接受共享可写的 `/tmp` 祖先。
- 读取使用 `O_NOFOLLOW`/`O_NONBLOCK`，有界读取并比较打开前后、读取前后及目录快照；不稳定或不安全时拒绝，不返回部分值。
- 文件须为严格 UTF-8。值不得为空、包含控制字符或首尾空白，不会静默去掉终止换行；读取缓冲区在结束时清零，但返回的 JavaScript 字符串不提供可擦除内存保证。
- Windows 和其它未适配平台返回 `UNSUPPORTED_PLATFORM`，不把缺少 POSIX 权限检查视为成功；Windows ACL 适配仍未完成。
- 错误不带 key、路径、原生异常 cause 或秘密。返回值仍是明文秘密材料，仅供可信进程内调用者使用，不得日志输出、序列化或透出控制面。

File 的路径和权限保护依赖可信 Linux 文件系统及操作系统权限边界，不抵御同权限主体/root 对进程或文件系统的控制。本轮未读取真实环境秘密或文件秘密，Linux 安全属性尚未通过专项验证。

### 12.3 B3：请求级 tools/list 过滤

修改 Server 的 `src/tools/runtime-security.ts`、`src/tools/initTools.ts` 和 `src/lib/initTools.ts`：

- 包装 SDK 原有列表处理器，按当前 Streamable/SSE 请求身份和 scope 过滤；Anonymous 不绕过配置规则。
- 不缓存主体过滤结果，不修改共享工具注册状态；scope 不足隐藏工具，非法规则拒绝列表请求。
- 主注册入口、初始化回退路径及库的 File/URL/Spec 入口接入；stdio/无上下文、原有 tools/call 二次授权行为保持既有语义。
- 当前依赖 MCP SDK 1.29 的内部 `_requestHandlers` 桥接，SDK 升级或之后替换列表 handler 都需要专项验证，不能视为稳定公共 SDK 契约。
- 未配置规则的工具仍按既有语义可见。本轮不实现持久撤销、重新认证、权限变更通知或已进入 handler 调用的中止。

### 12.4 待授权验证与后续依赖

- Parser 构建，以及文本加载的重复键/多文档/危险 YAML/深度和大小边界、现有 schema 回归。
- Env Provider 的缺失/非法 key/秘密大小与控制字符；File Provider 的权限、链接、祖先目录、文件替换、编码和有界读取。Windows 本机只能验证拒绝路径，Linux 正向及权限攻击场景须在隔离 Linux 环境执行，使用一次性合成秘密。
- Server 构建，以及 tools/list 的跨 Session 隔离、Anonymous、非法规则、主/库入口、stdio 兼容和 SDK 内部桥接；保留 tools/call 二次授权回归。
- C3 Registry 的稳定候选、Dry Resolution、原子 Reload 和审计，以及 C4 Resolver 的继承/覆盖和联网前拒绝，仍为 BACKLOG，不提前接入真实流量。
- 本轮未修改或运行测试、构建、数据库、真实秘密读取、部署及 Git 操作。

## 13. 2026-09-14 首次授权验证记录（历史失败）

> 本节保留当时的返回路径失败与待确认状态。该修正已获授权并完成，当前状态见第 14 节。

用户已授权补充并运行专项、Parser 和 Server 构建，完成后继续推进。任务包状态维持 DONE 1、IN_PROGRESS 16、BACKLOG 5、DEFERRED 1，不新增 DONE。

| 范围 | 当前结果 | 证据或原因 |
| --- | --- | --- |
| C1 文本加载专项 | 1 套，51/51，零失败，退出码 0 | `tmp/security-2026-09-14-loader-tests-184937-113.log` |
| Parser 构建 | 失败，退出码 2 | `tmp/security-2026-09-14-parser-c1c2-build-184820-730.log`；`src/credentials/secret-provider.ts(113,60)` TS2366 |
| C2 Provider 专项 | 已新增，尚未运行 | 等待 Parser 类型修正与构建通过，不使用失败构建的产物作为通过证据 |
| B3 tools/list 专项及 Server 构建/回归 | 已新增专项，尚未运行 | 等待 fresh Parser 构建成功，未使用旧 dist |
| 真实 Linux 文件权限专项 | 尚未运行 | Docker Linux 引擎未运行，WSL 只列出 docker-desktop 内部发行版 |

本轮新增的三个测试文件：

- `packages/api-nova-parser/src/credentials/loader.spec.ts`
- `packages/api-nova-parser/scripts/test-upstream-secret-provider.cjs`
- `packages/api-nova-server/scripts/test-mcp-tool-list-authorization.cjs`

C1 专项直接导入源代码，覆盖 JSON/YAML 正向与深冻结、重复键/多文档/tag/alias/merge/危险键、大小/编码/深度/节点预算、错误脱敏、保守 YAML 与 JSON 字符串兼容，以及被监测的 Provider/文件/网络接口未调用。该结果不等同于 Parser 整包构建或完整安全加载链路验收。

已报告的阻塞是 File Provider 异步读取函数缺少 TypeScript 可证明的结束返回路径。拟仅显式终止错误拒绝分支，不改变安全检查或放宽类型；目前等待用户确认，未修改生产代码。C1 专项通过不能抵消整包构建失败，因此未启动 C3/C4 的后续集成。

C2 专项仅使用随机命名的测试环境变量和一次性合成秘密；非 Linux 平台明确跳过真实权限/链接/稳定读取场景，单独检查不支持平台拒绝路径，不把跳过算作通过。B3 专项包含 SDK handler 桥接及 loopback 双 Session 场景，但尚未运行，不作成功承诺。

如需执行真实 Linux 文件专项，请启动本机 Docker Desktop 的 Linux 引擎并提供可使用的本地 Node.js 20+ 镜像，或提供已安装 Node.js 20+ 的隔离 Linux 环境。无需真实凭证、业务数据库或开放业务网络；当前未启动 Docker、安装发行版或拉取镜像。

## 14. 2026-09-14 类型修正、专项结果与 C3 后续开发

当前任务包为 DONE 1、IN_PROGRESS 17、BACKLOG 4、DEFERRED 1。TP-C3 从 BACKLOG 进入 IN_PROGRESS；没有新增 DONE，不以编译通过或测试夹具失败抵消行为验证缺口。

### 14.1 分阶段验证结果

| 阶段与范围 | 结果 | 日志 |
| --- | --- | --- |
| C2 最小类型修正后的 Parser 构建 | PASS；仅将终止拒绝改为显式 `return fail('SECRET_READ_FAILED')` | `tmp/security-2026-09-14-parser-c1c2-build-fixed-185616-141.log` |
| C1/C2 阶段 Parser 全量 Jest | 14 套，269/269，零失败、零跳过；包括既有 218 与 loader 51 | `tmp/security-2026-09-14-parser-full-c1c2-185644-158.log` |
| C2 独立 Provider 专项 | 83 项中 53 通过、0 失败、30 项 Linux 场景跳过；退出码 0 | `tmp/security-2026-09-14-secret-provider-tests-185638-343.log` |
| C1/C2/B3 阶段 Server 构建 | PASS | `tmp/security-2026-09-14-server-list-build-185642-150.log` |
| B3 新列表专项首次 | 34 个节点，26 通过、8 失败；4 个缺失 `$schema` 严格预期的叶子失败，另 4 个父节点连带失败 | `tmp/security-2026-09-14-mcp-list-tests-185656-733.log` |
| 既有 MCP 回归 | execution 20/20；HTTP/Transport/HTTP delivery/STDIO 共 53/53；3 个 smoke 均退出码 0 | `tmp/security-2026-09-14-mcp-list-regressions-185718-105.log` |
| C3 新增后 Parser 构建 | PASS | `tmp/security-2026-09-14-parser-registry-build-185943-441.log` |
| C3 新增后 Server 构建 | PASS | `tmp/security-2026-09-14-server-after-registry-build-190158-634.log` |
| C3 Registry 专项首次 | 1 套件失败，0 用例执行；三个内存 Provider 夹具缺必填 `type`，触发 TS2741 | `tmp/security-2026-09-14-registry-tests-190023-641.log` |

269 项 Parser 和既有 MCP 回归是在新增 C3 之前执行，不能据此宣称 C3 已验收。C3 专项未执行用例，故尚未重跑包含它的 Parser 全量。B3 的两个真实 Streamable/SSE 双 Session 场景通过，但四注册入口仍被严格 schema 预期失败阻断，不能将新列表专项整体记为 PASS。

### 14.2 C3 手动 Registry 已实现，但专项待修正夹具后执行

新增 `packages/api-nova-parser/src/credentials/registry.ts` 并在公共出口导出，同时新增 `src/credentials/registry.spec.ts`：

```ts
const registry = new UpstreamCredentialRegistry({ environment: 'test' });
const snapshot = await registry.reload(candidate);
registry.getStatus();
registry.captureSnapshot();
// Trusted in-process only:
await snapshot.resolveSecret(credentialId);
```

- 候选先由现有 schema 重新验证并深冻结，必须匹配 Registry 固定环境；拒绝复用当前 revision。
- 先为全部配置凭证进行 Dry Resolution，再在唯一提交点切换内存快照。失败保留之前的 snapshot/generation；首装失败保持未就绪。
- 在第一次 await 之前取得加载锁，并发 reload 返回 `RELOAD_IN_PROGRESS`；加载过程中已激活快照仍可读取。
- snapshot 固定该 revision 的凭证引用映射；秘密由 Provider 每次读取，不缓存明文，不承诺多秘密来源的值在时间上原子一致。
- 状态只包含环境、revision、generation、加载状态和静态错误码；秘密只通过可信进程内方法返回，不属于控制面响应。
- 可注入 Provider Factory 作为可信宿主适配器/测试接口，不接受来自配置文本的可执行适配器。
- 本轮不实现配置文件 Stable Read、Watch/debounce、持久化、权限入口、生命周期审计、跨进程切换或运行时/发布接入。C4 的继承、Header 最终注入和联网前阻断仍为 BACKLOG。

### 14.3 待确认的最小测试夹具修正

1. B3：SDK 返回的 inputSchema 包含 `$schema: 'http://json-schema.org/draft-07/schema#'`。仅补齐四入口的严格预期，保留 deepEqual 与全部安全断言。
2. C3：三个纯内存 Provider 夹具补 `type: description.type`，满足既有接口；不修改生产实现或降低类型检查。

两项已报告，等待用户确认后再修改和重跑。当前只有夹具兼容/类型失败证据，不提前断言生产行为正确或不存在其它缺陷。所有首次失败日志保留。

### 14.4 Linux 外部环境要求

Docker Linux 引擎当前未运行，WSL 只列出 docker-desktop 内部发行版。本轮没有启动引擎、安装 Linux、下载镜像或访问实际秘密；Provider 的 30 个真实 Linux 场景仍未运行，Windows 拒绝路径通过不代表 Linux 权限保护已验证。

操作步骤见[上游凭证 Provider Linux 隔离专项](../testing/upstream-secret-provider-linux.md)。仅需可用的 Docker Linux 引擎和已经批准、本地存在的 Node.js 20+ Linux 镜像；只只读挂载两份测试所需文件，在无网络、临时文件系统中使用合成秘密，不挂载业务目录或传递真实凭证。

## 15. 2026-09-14 B3/C3 回归闭合与 C4 纯 Resolver

当前任务包为 DONE 1、IN_PROGRESS 18、BACKLOG 3、DEFERRED 1。TP-C4 从 BACKLOG 进入 IN_PROGRESS；TP-B3、TP-C3 保持 IN_PROGRESS，没有新增 DONE。

### 15.1 最终验证结果

| 范围 | 结果 | 日志 |
| --- | --- | --- |
| B3 tools/list 专项 | 34/34，零失败、零跳过；包括四注册入口和真实 Streamable/SSE 双 Session 隔离 | `tmp/security-2026-09-14-mcp-list-contract-rerun-211928-971.log` |
| C3 Registry 专项 | 30/30，零失败、零跳过 | `tmp/security-2026-09-14-registry-tests-contract-rerun-211926-678.log` |
| C1/C2/C3 阶段 Parser 全量 | 15 套，299/299 | `tmp/security-2026-09-14-parser-full-c3-final-211957-859.log` |
| C2 Provider 最新本机复验 | 83 项中 53 通过、30 项 Linux 场景跳过 | `tmp/security-2026-09-14-secret-provider-final-190641-252.log` |
| B3 后既有 MCP 回归 | execution 20/20；HTTP/Transport/HTTP delivery/STDIO 共 53/53；3 个 smoke 退出码 0 | `tmp/security-2026-09-14-mcp-list-final-regressions-211959-255.log` |
| C4 首次 Parser 构建 | FAIL，运行分支已经拒绝 inherit，但 TypeScript 返回类型未排除该分支 | `tmp/security-2026-09-14-parser-c4-build-212649-706.log` |
| C4 类型收窄后 Parser 构建 | PASS | `tmp/security-2026-09-14-parser-c4-build-fixed-212718-064.log` |
| C4 Resolver 专项 | 22/22，零失败、零跳过 | `tmp/security-2026-09-14-parser-c4-tests-212733-708.log` |
| C4 后 Server 构建 | PASS | `tmp/security-2026-09-14-server-after-c4-build-212736-443.log` |
| C4 后 Parser 最终全量 | 16 套，321/321，零失败、零跳过 | `tmp/security-2026-09-14-parser-full-c4-final-212756-026.log` |

B3 首次失败日志 `tmp/security-2026-09-14-mcp-list-tests-185656-733.log`、C3 首次 TS2741 日志 `tmp/security-2026-09-14-registry-tests-190023-641.log` 和第二次契约样本失败日志 `tmp/security-2026-09-14-registry-tests-type-rerun-190629-099.log` 均保留。B3 只补 SDK 返回的 Draft-07 `$schema` 严格预期；C3 只为内存 Provider 补 `type`，并把拒绝样本改为契约明确禁止的首尾空白。没有删除或放松安全断言。

Parser 两次全量均出现 4 条 `RUNTIME_AUDIT_WRITE_FAILED` 安全诊断，但所有套件通过。本轮没有证明这些告警是无害竞争或已被修复，后续须单独定位测试审计写入环境；不能用退出码 0 将告警记为关闭。

### 15.2 C4 已实现切片

新增 `packages/api-nova-parser/src/credentials/resolver.ts`、`resolver.spec.ts` 并从 Parser 根入口导出：

```ts
resolveUpstreamCredential(
  snapshot: UpstreamCredentialRegistrySnapshot,
  request: UpstreamCredentialResolveInput,
): Promise<UpstreamCredentialResolution>
```

- 使用已捕获的不可变 Registry snapshot；不读取配置文件、不切换 revision、不缓存秘密。
- 按 `sourceServiceAssetId`、http/https、主机、规范端口和 basePath 边界选择 Site；多个匹配项采用最长 basePath。
- 支持 Endpoint Definition ID 或 Method/Path 二选一。Endpoint 缺失或显式 inherit 回退 Site；Site 顶层仍为 inherit 时拒绝 `CREDENTIAL_POLICY_UNRESOLVED`，不降级成匿名。
- `none` 返回冻结的空 Header；reference 每次通过 snapshot 读取秘密，生成 Bearer 或规范化 API Key Header。结果和 Headers 冻结，错误不包含 URL、ID、Provider cause 或秘密。
- 拒绝 URL 凭证、fragment、尾点 Host、非 HTTP(S)、编码点/斜杠/反斜杠、错误资产/协议/Host/Port、歧义 Endpoint selector、访问器输入及不安全秘密值。
- 这是纯解析和最终认证 Header 计算，不发起网络或 DNS，也不修改现有 Gateway/MCP 流量。

### 15.3 尚未闭合边界

- C4 尚未接入 Gateway/MCP；调用方“最后注入”顺序、消费者 Header 再清理、必需策略缺失的真实联网前阻断尚未做跨包集成。
- `allowedHosts` 当前只参与初始 Site Host 检查。重定向目标逐跳复验、DNS 解析、私网/回环/链路本地地址、重绑定与代理环境变量属于 F3 SSRF 和运行时适配，不由纯 Resolver 声称完成。
- Endpoint Definition ID 与 Method/Path 的资产归属一致性仍需实际 Endpoint Registry 验证；当前只解析已通过 C1 schema 的候选。
- C3 的 Stable Read、Watch/debounce、生命周期审计、持久化和跨进程原子切换仍未完成。
- C2 的 30 个真实 Linux 文件权限场景仍待隔离环境执行；Windows ACL 未适配。
- B3 尚无持久撤销、重新认证或权限变更通知，仍依赖 MCP SDK 1.29 内部 handler 桥接。
- 本轮未访问实际秘密、真实外部服务或业务数据库，未部署、未运行联网依赖审计，也未执行 Git。

## 16. 2026-09-14 C4 Gateway 可选适配接入

任务包统计保持 DONE 1、IN_PROGRESS 18、BACKLOG 3、DEFERRED 1。TP-C4 仍为 IN_PROGRESS，没有新增 DONE。

### 16.1 实现范围

新增：

- `packages/api-nova-api/src/modules/gateway-runtime/services/gateway-upstream-credential-resolver.ts`
- `packages/api-nova-api/src/modules/gateway-runtime/services/gateway-upstream-credential-resolver.spec.ts`

修改 `gateway-proxy-engine.service.ts`：

- 新增可选注入令牌 `GATEWAY_UPSTREAM_CREDENTIAL_RESOLVER`。宿主可通过 `createGatewayUpstreamCredentialResolver(captureSnapshot)` 将 C3 当前不可变快照接入 Gateway。
- 每次请求先捕获一个 snapshot，再以 Source Service Asset ID、目标 URL 和 Endpoint Definition ID 调用 C4；失败映射为固定 `503 gateway_upstream_credential_unavailable`，不携带底层 URL、路径、Provider cause 或秘密。
- 解析发生在创建上游 `http.request` 之前。启用适配器时，不再叠加旧 `credentialRef`；认证 Header 仍在消费者 Header 清理后最后注入。
- 适配器返回当前选择的 credential Header 名以及候选中全部托管认证 Header 名。即使 Endpoint 为 `none`，消费者传入的同名托管 Header 仍会被剥离。
- 保留原 `buildForwardHeaders(..., credentialRef)` 私有调用兼容，既有测试与未配置运行时继续使用旧 `env-headers`。
- 适配器本身不读取文件、环境或网络；秘密读取委托给 snapshot/Provider。结果只包含 Header 与 Header 名，未返回 Secret Reference。

### 16.2 验证证据

| 范围 | 结果 | 日志 |
| --- | --- | --- |
| 首次 API 构建 | 日志只有启动行，无完整退出证据，不作为 PASS | `tmp/security-2026-09-14-api-gateway-c4-build-213501-518.log` |
| API 构建重跑 | PASS | `tmp/security-2026-09-14-api-gateway-c4-build-rerun-213550-126.log` |
| Gateway C4 首次专项 | 5 项中 4 通过、1 失败；测试把规范化候选再次交给只接受原始候选的 Registry | `tmp/security-2026-09-14-gateway-c4-tests-213623-227.log` |
| Gateway 首次兼容回归 | 7 套中 6 套通过；65 项中 59 通过、6 失败，旧私有方法调用未提供新增参数 | `tmp/security-2026-09-14-gateway-c4-regressions-213625-113.log` |
| 候选/签名兼容修正后 API 构建 | PASS | `tmp/security-2026-09-14-api-gateway-c4-compat-build-213733-936.log` |
| Gateway C4 最终专项 | 1 套，5/5 | `tmp/security-2026-09-14-gateway-c4-tests-final-213803-822.log` |
| Gateway 最终回归 | 7 套，65/65 | `tmp/security-2026-09-14-gateway-c4-regressions-final-213807-180.log` |

首次失败全部保留。测试夹具改为把原始候选交给 Registry；生产方法增加旧私有签名兼容并从旧 credentialRef 自行恢复 Header/托管名。没有删除或降低安全断言。

### 16.3 未完成边界

- GatewayRuntimeModule 尚未提供默认 Registry/配置加载 Provider，当前 C4 适配器不会自动启用；这避免在没有批准配置来源时改变远端既有行为。
- 尚无管理 API、启动文件参数或 Watch/reload 生命周期接入。启用方式和权限边界需随 C3 Stable Read/审计共同设计。
- MCP transformer 仍使用旧 `env-headers` 后再由 authManager 覆盖的路径；共享 Resolver 尚未接入 MCP。
- Gateway 仍允许非托管业务 Header 透传，不是完整业务 Allowlist；只保证消费者常见凭证和当前候选声明的认证 Header 被剥离后再注入。
- 当前实现没有重定向逐跳复验。Parser transformer 仍允许 Axios 最多 5 次重定向，redirect/DNS/SSRF 必须单独闭合，不能由初始 URL 的 C4 Site 匹配替代。
- C2 Linux 30 项、Windows ACL、C3 Stable Read/Watch/审计、跨进程切换、真实外部服务与生产部署仍未验证。

## 17. 任务包依赖与状态漂移复核（2026-09-14，历史决策，当前见第 18 节）

### 17.1 漂移结论

- 当前 18 个 `IN_PROGRESS` 并不代表 18 个任务同时受阻，而是混合了“代码切片已完成但未激活”“仅缺平台证据”“仍缺策略决策”和“跨模块验收尚未完成”四类状态。
- 计划中的阶段顺序曾被误读为硬依赖。实际存在两条可并行主链：消费者访问链 `A1 -> A2 -> B1/B2 -> B3/D2/A3`，上游凭据链 `C1 -> C2 -> C3 -> C4 -> D1/E1 -> F3`；最终在 `F1/F2/F3 -> F4` 汇合。
- C1-C4 的主要漂移是实现已前移、运行时激活滞后。C4 Gateway 适配已存在，但缺少 C3 配置源与默认 Provider 注册，因此仍不能按生产闭环计为 `DONE`。

### 17.2 本轮关键节点

- 修复 C1→C3 接缝：新增 `UpstreamCredentialRegistry.reloadText(text, format)`，在获取同一重载锁后完成文本解析、候选校验、Provider Dry Resolution 和原子快照切换。
- 保持边界不降级：原始对象入口仍拒绝已规范化候选，不以冻结对象作为可信标志；解析或校验失败保留当前快照并输出静态错误码。
- 验证证据：文本接缝专项 6/6、Parser 全量 17 套 327/327、Parser/Server/API 构建、Gateway C4 专项 5/5 均通过。Parser 全量仍出现 4 条既有 `RUNTIME_AUDIT_WRITE_FAILED` 警告，不视为闭环。

### 17.3 后续关键路径与并行面

| 优先级 | 节点 | 依赖判断 | 执行要求 |
| --- | --- | --- | --- |
| CRITICAL | C3 Stable Read 与默认配置源激活 | 阻塞 Gateway/MCP 的真实运行时装载 | 先定义稳定读取、失败保旧快照和启动失败语义，再注册默认 Registry Provider |
| NEXT | C4 Gateway 默认激活与 MCP 接入 | 依赖 C3 配置源，不应绕过 Registry | Gateway 复用现有可选适配；MCP 使用同一快照/解析器，禁止复制凭据逻辑 |
| PARALLEL | D1 业务 Header allowlist | 可与 C3 独立推进 | 先固化允许透传的业务 Header 与剥离优先级 |
| PARALLEL | F3 redirect/DNS/SSRF 威胁模型 | 可先设计，执行依赖请求层能力 | 明确重定向逐跳校验、DNS 解析与私网地址策略，不静默塞入纯 Resolver |
| EVIDENCE | C2 Linux 权限验证 | 不阻塞本机纯逻辑开发 | 需要真实 Linux 主机执行 `docs/testing/upstream-secret-provider-linux.md` 的 30 项权限语义用例 |

在 C3 配置源激活完成前，暂停新增更多凭据消费适配器，避免继续扩大“代码存在但不可运行”的漂移面。

## 18. 2026-09-14 C3 Stable Read 与 Gateway 配置激活

### 18.1 已完成切片

- 新增 `readStableUpstreamCredentialText`：1 MiB 有界读取、两次采样间隔 50 ms，每次检查文件身份/大小/时间戳/权限模式/链接数，比较采样内容，拒绝路径别名、符号链接、硬链接、非普通文件、非法 UTF-8 和读取期间替换。
- 新增 `UpstreamCredentialRegistry.reloadFile(path, format)`，文件读取到原子激活全程复用对象/文本重载锁。失败保留上一快照，错误仅为静态码，不暴露文件路径/Secret；当前文件激活只支持 manual，watch 明确拒绝。
- GatewayRuntimeModule 已注册 ConfigService 异步 Registry/Resolver Provider。显式配置文件、格式和环境标识后，在 Resolver/Proxy 构造前完成 Schema、环境与 Dry Resolution 校验；失败阻止 API 启动。三个配置项均未设置时保持已有 env-headers 路径。
- 每次 Gateway 请求捕获当前 Registry 快照；JSON/YAML 启动、快照更新后的 None、缺文件/坏配置/坏 Secret/环境不符和未配置分支均有专项证据。
- D1/F3 并行产出[请求头与网络边界契约](./security-header-network-boundary-contract.md)：30 项验收矩阵为 draft 提案，未计为功能实现。Gateway 单跳与 Parser 最多五次跳转的差异成为 MCP 接入的显式依赖。
- 配置操作、文件信任边界和 Linux 外部补证要求见[Gateway 文件激活手册](./gateway-upstream-credential-file-activation.md)。

### 18.2 回归发现与修复

扩大到全部 Gateway 测试时，首次结果为 2 套失败、4 项失败、119 项通过。失败来自两份旧夹具：请求 ID 仍期待客户端任意字符串、超时文案仍期待动态时长，以及 fake timers 与真实审计写入混用导致重试测试超时/循环告警。

已同步内部请求 UUID 与响应/指标关联断言，保留超时类型并增加静态消息/504 断言；编排测试隔离不具备 HTTP 生命周期的审计依赖，重试按 24 ms + 1 ms 边界有限推进并清理定时器；真实代理集成使用独立临时审计目录、flush 与连接清理。没有修改生产行为来迎合旧预期，没有使用 forceExit。首次失败日志保留。

### 18.3 验证证据

| 验证 | 结果 | 日志 |
| --- | --- | --- |
| Parser 构建 | PASS | `tmp/security-c3-file-source-parser-build.log` |
| Parser 全量 | 18 套、342/342 PASS，新增稳定文件源 15 项 | `tmp/security-c3-file-source-parser-tests.log` |
| API 构建 | PASS | `tmp/security-c3-file-source-api-build.log` |
| Server 构建 | PASS | `tmp/security-c3-file-source-server-build.log` |
| Gateway 配置激活与 Resolver | 2 套、19/19 PASS，其中 Provider 新专项 14 项 | `tmp/security-c3-file-source-activation-tests.log` |
| Gateway 首轮扩大回归 | FAIL，2 套/4 项失败，119 项通过；保留失败证据 | `tmp/security-c3-file-source-gateway-tests.log` |
| Gateway 夹具修复专项 | 2 套、14/14 PASS，detectOpenHandles 正常退出 | `tmp/security-c3-gateway-fixture-tests.log` |
| Gateway 最终完整专项 | 15 套、123/123 PASS，detectOpenHandles 正常退出 | `tmp/security-c3-file-source-gateway-final.log` |

Parser 全量仍有 4 条既有 `RUNTIME_AUDIT_WRITE_FAILED` 告警，不视为审计持久化闭环。本轮仅运行合成文件/环境凭据与本地测试服务，没有验证真实 Linux Secret 文件权限、业务数据库、生产配置或外部上游。

### 18.4 当前依赖与退出条件

| 执行视图 | 任务 | 本轮状态与下一步 |
| --- | --- | --- |
| 已验证切片 | C1/C2/C3 -> Gateway C4 | 文本/文件稳定读取、进程内原子 Registry、默认注册且显式启用的 Gateway Provider 已打通 |
| 下一关键节点 | E1/C4，并依赖 B3/E0 | MCP 可信 Source Asset/Endpoint 映射、实际发送前共享 Resolver 接入；需要处理 Parser 自动跳转边界 |
| 并行可推进 | C3 管理能力 | 受权 Manual Reload/状态 API、资产归属校验、审计及 Watch 生命周期；文件 watch 模式目前拒绝 |
| 并行设计已产出 | D1/F3 | Header allowlist 与网络边界矩阵；配置来源/迁移、内网例外/代理政策仍需落到具体实现契约 |
| 外部证据轨 | C2/F4 | 真实 Linux Provider 文件权限 30 场景待补证；按已有隔离操作说明执行 |

任务包主统计仍为 DONE 1、IN_PROGRESS 18、BACKLOG 3、DEFERRED 1。C1 完整凭据类型/安全对账、C3 管理/Watch/审计/多进程、C4 MCP/资产归属、D1 allowlist 和 F3 网络控制均未达到各自整包退出条件。
## 19. 2026-09-14 活跃任务并发：D2 缓存身份边界

本轮与 OBS-TP13/14 并行修改 GatewayCacheService 及专项测试。缓存读写共同要求显式有效模式与匹配鉴权上下文；internal anonymous 仍按 JWT 处理。JWT 必须具备 authenticated principal 和有效 callerId，API Key 必须具备 consumerId/keyId，不能用 actorId 或匿名兜底。缺失、非法、不匹配身份时 resolve 返回 null、store 返回 false，不访问缓存。

缓存键隔离模式、主体、凭证和 JWT 权限集合；同一授权集合的 Token 续签可沿用缓存。主链先鉴权再缓存的顺序不变，不能把缓存护栏作为认证服务替代。

| 验证 | 本轮结果 | 证据 |
| --- | --- | --- |
| 缓存专项 | 41/41 PASS | tmp/security-d2-cache-tests.log |
| Gateway全量 | 15套、161/161 PASS，detectOpenHandles正常退出 | tmp/security-d2-gateway-regression.log |
| 整合API构建 | PASS，含OBS实时模块接线与能力声明 | tmp/active-tasks-api-build.log |

本轮未增加整包 DONE：安全仍 DONE1、IN_PROGRESS18、BACKLOG3、DEFERRED1。D2 的 IP 层、Anonymous 独立 Bucket 与完整层级限流仍未闭合。下阶段关键依赖仍为 E1/C4 的 MCP 可信映射/共享 Resolver，C3 受权 Reload/审计以及 D1/F3 的请求头和网络边界。外部平台验收继续独立记录。
## 20. 按规划继续执行：C3固定源重载管理

新增 GET /api/security/upstream-credentials/status（JWT + config:read）、POST /api/security/upstream-credentials/reload（JWT + config:update）。用户和权限每请求重新读取；无权限/失效Token拒绝。两个接口均 no-store，Swagger记录结构与错误。GatewayRuntimeModule注册同一个Registry上的AdminService，不复制运行时凭据状态。

POST仅接受 expectedGeneration（非负整数）与reason（1–500非空字符且无控制字符），不接受任意路径/格式/秘密。固定源在构造时捕获；并发和版本冲突409。审计只保存reason存在性与摘要，避免理由夹带秘密。先持久pending意图，再执行reloadFile，失败保留旧快照；成功/失败记录实际generation。结果审计失败返回503 RELOAD_AUDIT_UNAVAILABLE及实际generation，不能声称已回滚；客户端先读状态和审计再决定操作。

| 验证 | 结果 | 证据 |
| --- | --- | --- |
| 管理服务/HTTP专项 | 15/15，含12个真实Registry/合成文件和3个JWT/权限HTTP场景 | .tmp/security-c3-admin-20260914.log |
| Gateway整合全量 | 17套176/176，detectOpenHandles正常退出；包含管理专项 | tmp/planned-next-gateway-tests.log |
| API整合构建 | PASS | tmp/planned-next-api-build-final.log |

没有操作真实凭据文件或部署；只运行合成夹具。C3仍IN_PROGRESS：Watch、多进程协调、资产数据库归属校验尚未闭合。内存Registry激活与数据库审计不是一个可回滚事务，当前以先记意图、再记结果与可核查generation表达该边界。安全23包统计不变。

## 21. D1 请求头大小写与Connection提名边界

Gateway聚合所有大小写Connection键及数组提名，先剥离客户端四类代理生成字段别名，再重建唯一host/proto/for/request-id输出。被Connection提名的XFF不再重新复制客户端值；普通XFF仍保留既有prefix+peer政策，不视为可信身份。None候选托管凭据仍剥离，Resolver拒绝发生在连接之前。

新真实回环发送6/6，Gateway全量17套176/176且detectOpenHandles正常退出，API构建PASS；见[本轮记录](../audits/2026-09-14-heartbeat-header-consumer-wave.md)。二进制正文与length一致性已回归；业务allowlist、完整framing/响应侧及网络策略仍未闭合。安全统计仍DONE1、IN_PROGRESS18、BACKLOG3、DEFERRED1，不新增整包DONE。

## 22. E1/C4可信操作映射前置基础

新增Parser trustedOperationBindings与不可变编译表，严格验证method/path及绑定存在性；缺失映射使整体转换失败。标准HTTP handler固定Endpoint/Source Asset身份，不接受Tool参数/OpenAPI扩展覆盖。Server主core Transformer及transformOpenApiToMcpTools两个入口透传。未配置选项保持既有路径；customHandlers不外推保证。

Parser全量19套349/349（新7项包含其中），Server入口3/3，Parser/Server/API/UI构建PASS。测试与日志见[本轮记录](../audits/2026-09-14-routing-policy-mapping-wave.md)，接入方式见[可信映射说明](./mcp-trusted-operation-bindings.md)。数据库归属核验、共享Resolver实际发送与每跳网络边界、CLI秘密移除仍未闭合；E1/C4继续IN_PROGRESS，23包统计不变。

## 23. E1/C4显式单跳共享Resolver

可信进程内upstreamCredentialPolicy single-hop必须配trustedOperationBindings；每调用捕获一次冻结Registry快照，按Endpoint ID、Source Asset和目标URL解析，失败零Axios发送。最终只注入当前凭据，None无旧env/authManager回退；私有Axios隔离全局认证默认值与interceptor。固定maxRedirects=0，返回3xx不追跳；legacy路径不自动切换。

审查复现并关闭None旧env认证头泄漏及非枚举/后加handler getter执行两项，均有定向回归与独立复核。Parser20套363/363，Server入口4/4，Gateway17套176/176通过。具体日志和环境见[本轮记录](../audits/2026-09-14-single-hop-capacity-diagnostics-wave.md)。生产托管启动链、DB归属、自动逐跳/DNS/SSRF及CLI秘密治理未闭合；23包状态不变。
## 24. 可信资产映射生成与提交整理

新增 createMcpTrustedOperationBindings：由可信管理代码提供同一仓储快照中的运行资产、已选择成员、端点、源资产及生成的 OpenAPI，检查 UUID、归属关系、成员启用状态、已有生命周期状态和操作一一覆盖。重复/缺失/跨资产映射以固定 INVALID_MCP_OPERATION_OWNERSHIP 拒绝；输出为冻结副本，不使用 x-* 作为归属证据。生成器专项 19/19、API 整包构建通过。

此切片未自动接入装配、部署和托管进程入口，不保证传入行来自数据库或一致事务；调用方必须提供可信一致快照。下一次生成会拒绝已禁用成员，已创建 handler 的运行中撤销尚未接线，发布权限也仍由既有门禁负责。C4/E1 继续 IN_PROGRESS。

管理 JWT 启动拒绝校验单独复核 41/41 并提交；缺失策略提示完成中英文本地化，UI 构建通过。全部 39 包统计不变：DONE 11、IN_PROGRESS 23、BACKLOG 4、DEFERRED 1。本轮本地提交和远端推送阻塞见[提交与归属生成记录](../audits/2026-09-14-commit-ownership-wave.md)。
## 25. 2026-09-15 MCP装配可信映射接线

assembleMcpRuntimeAssetPayload 现在捕获 asset 和 membership 查询结果的值副本，用同一份数据组装 OpenAPI 并生成可信映射，再通过 Server 第9参数传给标准工具转换。选中行缺端点/源服务不再静默跳过；跨runtime/endpoint/source或失效端点以固定 INVALID_MCP_OPERATION_OWNERSHIP 拒绝。禁用成员仍按原选择规则排除，未启用single-hop。

现有 asset、membership、endpoint、source、profile、publish 与 upstream 查询彼此独立；structuredClone 仅隔离返回对象后续变更，不是数据库一致事务。前轮helper的一致仓储快照前置条件尚未实现，本轮明确限定为捕获行内部关系核验。受管进程启动、持久化可信传递、运行中撤销和上游事务一致性仍未闭合。

3套50/50（装配8、生成器19、原服务23）及API整包构建通过。前轮4笔提交已获用户确认并成功推送origin/main至eaa143a。本轮证据见[装配接线记录](../audits/2026-09-15-mcp-assembly-ownership-wave.md)。安全23包及合计39包统计不变，没有新增整包DONE。

本轮新增装配接线的远端推送被自动审批另行拒绝：此前确认只覆盖原4笔提交，新增源码/测试/文档待明确确认；本地提交继续完成。
## 26. 单语句归属读取与并发恢复推进

7ea27a0已获用户明确授权并推送origin/main，远端核对一致，前节推送阻塞已解除。MCP装配现在通过readMcpOwnership单条LEFT JOIN读取runtime/membership/endpoint/source，SQL.js实测仅一次SELECT；保留悬空关联以便固定拒绝，空资产与不存在资产区分，10001行哨兵拒绝超过10000行而非返回截断结果。装配不再调用原归属N+1读取。

profile、publication和upstream仍独立读取；单语句只限定归属链，不是整个装配/发布流程的一致事务，也不提供运行中撤销。最终四套56/56和API整包构建通过。并发扫描恢复与UI诊断修复见[本轮记录](../audits/2026-09-15-ownership-recovery-wave.md)。安全23包与合计39包统计不变，C4/E1仍IN_PROGRESS。
## 27. 发布信息与归属同语句读取

readMcpOwnership新增唯一发布绑定LEFT JOIN和按membership取MAX(version)的最新profile相关子查询，装配删除这两类独立N+1读取。数据库已有membership/version唯一约束，历史profile不乘行；保留null关联和现有publishedToMcp OR active选择，仍按最高版本而非publicationProfileId选择描述。

四套63/63通过，含SQL.js一次SELECT、多版本不重复与下一read更新、真实装配发布条件；PostgreSQL driver仅离线验证引用/占位符，不代替真实数据库验收。API构建通过。上游resolve及验证/激活仍在该语句之外，受管启动和运行中撤销未完成；任务包统计不变。证据见[本轮记录](../audits/2026-09-15-publication-shutdown-wave.md)。
## 28. 上游解析与捕获归属交叉核验

已确认旧装配捕获source A后，另一次resolve可能选择更新后的binding source B及B实例，造成A身份配B URL/credentialRef。resolver现在返回绑定membership/source身份，MCP装配在buildBaseUrl/transform之前同时检查捕获endpoint链、返回membership、绑定source与实例source；缺失或不符固定拒绝MCP_UPSTREAM_OWNERSHIP_MISMATCH。

五套76/76与API构建通过，包含真实resolver到装配的同源通过/跨源拒绝、缺字段、返回字段兼容回归。该防护只检测跨源关联漂移，不解决同源版本变化、候选验证/激活事务或运行中撤销。观测停机和Gateway分页并行复核未发现新增可复现问题，不作无依据修改。安全与OBS整包统计不变；见[本轮记录](../audits/2026-09-15-upstream-ownership-wave.md)。
## 29. 旧候选激活与部署元数据保护

activateMcpCandidate新增当前activeRevision与run.previousActiveRevision比较，以及记录的上游binding身份/revision/active状态检查。记录数组缺失、非法revision或重复记录固定拒绝；verificationRequired为true时缺失/非法时间或不早于run.createdAt也拒绝。错误为MCP_CANDIDATE_STALE，历史缺少版本记录的候选需重新规划验证。

deploy事务不再保存装配阶段捕获的旧资产，而是重读当前资产后仅合并部署信息，保留较新的失效标记与其它元数据。SQL.js证明旧候选拒绝时前置server写入、asset和run状态一起回滚。最终MCP七套101/101、API构建通过，见[本轮记录](../audits/2026-09-15-activation-gc-wave.md)。这是读取时点guard，不是跨进程CAS；未标记修改、计划前混读与完整执行快照仍未覆盖。任务包统计不变。


## 30. 任务包完成度审核与重拆

原39专项统计没有新增父包DONE，但该数字不代表全项目完成率。已确认包过大与最近调度偏移并存：连续推进管理装配/GC相邻修复，未先冻结子项出口；父表和交接摘要也滞后。现把已验收切片转回归维护，并以独立子任务状态调度，详见[审核报告](../audits/2026-09-15-work-package-replan.md)。SEC-E1-01仅完成技术草案交付，尚未完成受管启动代码；下一队列E1-01R、OBS-14-02、PROD-01。

## 重排首批技术审查（2026-09-15）

SEC-E1-01R DONE：受管启动方案0.2.0第9节冻结02A真实Node IPC、精确环境、ACK不等于READY、失败关闭和legacy边界，列出本机真实child必选验收。仅完成DOC技术审查；SEC-E1-02A已READY但未实现，E1父包仍IN_PROGRESS。普通技术实施无新增待用户批准事项。详见[统一子任务状态](./active-work-package-execution-status.md)。
## 31. 重拆第二批受管MCP通道与边界（2026-09-16）

SEC-E1-02A、02B1、02B2的限定代码出口已完成。02A由父进程直接启动真实Node child，使用私有IPC、精确环境、无shell/秘密argv，并把handoff ACK与监听后的READY区分；真实child通道专项11/11，既有ProcessManager回归3/3。02B1从受保护ConfigService来源准备固定Registry，重读资产/绑定/候选、稳定文件版本与环境后构造一次性交付，专项23/23。02B2由child再次稳定读取Registry并核对交付版本，标准MCP handler使用共享single-hop Resolver；Streamable/SSE在实际监听后才发READY，入站仅接受已配置API Key，缺失或不支持的模式在监听前拒绝。三脚本联合47/47覆盖继承、端点覆盖、None、缺Secret零发送和302零跟随，使用合成配置与回环上游。

这些结果只证明通道、准备和独立child运行时的隔离实现；当前产品Server生命周期未接入已验收的显式trusted_ipc_v1启动路径。SEC-E1-02C1的未验收草稿已撤回，自动审批要求具体的生产启动/停止状态行为授权；不能把草稿、PID、ACK或单独child测试记为RUNNING闭环。02C2重启/失败/legacy和03真实产品路径执行仍待前置。旧CLI及旧托管秘密argv未自动迁移；没有Linux、真实业务Registry或部署验收。详见[受管交付设计现状](./managed-mcp-credential-handoff-plan.md)及[统一子任务台账](./active-work-package-execution-status.md)。SEC-E1父包继续IN_PROGRESS。
## 最新限定进展：SEC-A1-02B3（2026-09-21）

持久private_api_key映射实验运行时api_key；准备阶段双次数据库快照和受控环境模式一致性检查，交付包携带必填inboundAuthMode，child监听前核对，父端READY对照捕获模式。缺失/未知以及暂不支持的private_jwt、anonymous明确拒绝。未发布实验性v1严格新增字段，旧无字段包拒绝，不默认api_key。

API父端/SQL.js/真实IPC46/46，真实child Streamable与SSE正例和监听前负例13/13通过；Server构建、API类型检查通过。READY证据只属于实验性handle，现行CLI effective仍unknown；不接生产生命周期、不宣称支持JWT/匿名受管运行时。详见[本批证据](../audits/2026-09-21-managed-inbound-mode-evidence.md)。

TP-A1/TP-A2父包仍IN_PROGRESS；B4 UI和A2-01B综合拒绝矩阵已就绪，状态以[子任务台账](./active-work-package-execution-status.md)为准。

## MCP鉴权模式界面交付（2026-09-21）

MCP发布/重发布弹窗必须明确选择private_jwt、private_api_key或anonymous；新记录、旧unknown和不支持值不默认匿名。保存时提交同一模式，重开按已保存记录回填。模式改变使旧预览失效；运行中改模式本地阻断，服务端状态竞争返回的冲突保留草稿并提示先停止服务。草稿、已配置、预览及实际生效分别显示，实际模式仍unknown。

详情对未部署/null服务安全显示未知，Gateway不显示MCP标签。19项Vue状态/真实SFC模板SSR通过，UI构建和最终类型检查通过；SSR使用组件替身，未执行真实浏览器端到端，不宣称完整后端保存到请求闭环。详见[UI交付证据](../audits/2026-09-21-mcp-mode-ui-evidence.md)。

B4限定出口DONE，A1-02D已就绪，TP-A1父包保持IN_PROGRESS。

## MCP三入口拒绝验收（2026-09-21）

SEC-A2-01B核对RuntimeAssets部署保存、应用自动恢复和child启动三种入口。保存入口的缺失/未知/非法模式在候选生成、端口分配与持久化前拒绝；三种显式有效模式可以保存，保存不表示启动。恢复经onModuleInit→startServer调用真实凭证预检，不从开发环境全局anonymous填补未知持久模式，只有显式匿名配置可追溯通过。

验收发现ProcessManager.restartProcess原先先stop再校验，已将环境/凭证预检前移到停止与状态变化前，真正spawn前仍重新校验；配置无效时保留原进程。父任务servers及runtime-assets联合12套88/88，现行CLI HTTP3/3，实验child14/14，API构建通过；见[入口矩阵证据](../audits/2026-09-21-mcp-rejection-matrix.md)。实验IPC未接生产生命周期，effective继续unknown。A2子项完成不代表父包完整签收，A3仍等待B1统一凭据模型。

## 当前版本PostgreSQL空库验收（2026-09-21）

SEC-A4-02此前缺明确隔离目标；现通过本机PostgreSQL16.10二进制新建专用集群解除阻塞。新wrapper只保留OS执行环境，显式设置专用身份、随机回环端口、数据库和私有日志根，JWT为内存随机值；现有database-tool创建随机空库，69实体/69业务表、3迁移、初始/连接重建零漂移、重连0迁移，持久化/约束回滚、真实API启动和管理匿名401均通过。父任务独立复跑，集群停止删除确认。

这里的restart是数据库连接重建，不是PG守护进程故障恢复；不覆盖历史版本升级、Linux、生产配置或备份恢复。详见[PG空库证据](../audits/2026-09-21-isolated-postgres-schema.md)。父包状态不因单项环境证据自动升级。

## 文件自动重载交付（2026-09-21）

SEC-C3-01按原定义DONE。固定源主机配置显式启用Watch，失败保留旧代，关闭阻止在途提交；管理员在审计等待期间遇到代次变化会拒绝旧请求。详见[真实监听证据](../audits/2026-09-21-registry-watch.md)。父包C3仍IN_PROGRESS，未覆盖DB归属、Linux权限和多进程传播。

## IP与匿名独立限流交付（2026-09-21）

SEC-D2-01按原定义DONE。真实HTTP证明暖缓存仍计数、伪造转发头不改peer桶、匿名与合法凭证桶分离、无效凭证不能读取缓存。计数为当前进程内；详见[限流证据](../audits/2026-09-21-independent-rate-limits.md)。父包D2仍IN_PROGRESS，完整层级组合依赖B1-02。

## 鉴权保存到执行闭环与A1退出复核（2026-09-21）

[真实闭环验收](../audits/2026-09-21-auth-publication-loop.md)补齐A1-02D。Gateway实际策略编译、候选回放、事务激活与冷恢复后18项HTTP通过；MCP真实RuntimeAssets发布、失败不激活/保留旧版、磁盘重开、6次实际CLI与tools/call通过；stdio12/12复验local_process。两个启动缺陷由真实链发现并修复。

对照归档TP-A1原退出条件与当前SEC-A01：Gateway/MCP三模式已收敛，stdio明确local_process；旧OAuth/非法模式不转为可调用策略，现有UI禁用占位不属于可提交模式。结合A/B1-B4/C先前证据，A1父包DONE。MCP管理摘要effective仍为unknown，测试中的真实鉴权结果不被写成生产探测状态。管理HTTP规范下载鉴权、浏览器自动化、Linux与生产部署分别未据此验收。

## Registry配置归属验证（2026-09-21）

C3-02完成。Gateway每次配置激活在可信DB一致读事务中核验Source存在、Endpoint ID或method/path属于该Source；数据库错误和跨源配置失败保旧并输出固定错误。Parser宿主回调不能由配置文件注入。详见[归属验收](../audits/2026-09-21-registry-db-ownership.md)。C3-03转READY，父包C3仍IN_PROGRESS。

## Windows秘密文件权限验收（2026-09-21）

C2-02完成，主任务复验[NTFS矩阵](../audits/2026-09-21-windows-secret-acl.md)28/28。读取合法受限文件及轮换成功；越权ACL、硬链接、重解析点和写入冲突均拒绝。Linux真实权限出口仍未执行，父包C2保持IN_PROGRESS。

## 统一消费者凭证模型（2026-09-21）

B1-01完成，见[模型与验证证据](../audits/2026-09-21-unified-consumer-credentials.md)。现有凭证表新增版本化accessPolicy，管理API保存受信Actor、Protocol/Tool Scope/Subject/Expiry；同一keyId.secret在Gateway/MCP使用同一摘要与限制。仅创建时返回完整Key，列表不返回Key或摘要。受权摘要导出用于显式启动配置，受管CLI强制匹配Runtime ID。

B1父包仍IN_PROGRESS：Rotation Family、窗口和运行中child撤销/轮换传播未完成；UI凭证表单未新增这些字段，字段管理由本轮API提供。当前数据库基线已复验4迁移，历史3迁移报告保留历史含义。

## 在线凭证与临时匿名闭环（2026-09-21）

[本批证据](../audits/2026-09-21-live-rotation-temporary-anonymous.md)关闭B1-02/A3-01并复核A2/B1/A3父出口。历史章节保留当时事实；当前状态以阶段表为准。C3-03补E1-02C1依赖回WAIT_DEP，旧READY结论已纠正。

## 六层限流组合收尾（2026-09-21）

D2-02完成，见[组合证据](../audits/2026-09-21-layered-rate-limit-composition.md)。共享窗口混配漏洞已修复；D2父包保留原依赖B2/D1，不再声称组合功能未完成或扩大为多节点任务。

## 持久撤销与会话（2026-09-21）

[真实双传输证据](../audits/2026-09-21-persistent-session-revocation.md)关闭B3-01，原实现经DB resolver逐请求验证已满足出口，没有重复开发Session缓存。已接纳的在途调用不取消，明确留给E1-04。

## JWT参数闭环（2026-09-21）

[实际生命周期证据](../audits/2026-09-21-jwt-policy-lifecycle.md)关闭B2-01与TP-B2。Gateway和MCP共享参数，MCP运行中改变策略必须先停止；固定信任源未改为令牌驱动。

## 临时匿名界面（2026-09-21）

[F2-02证据](../audits/2026-09-21-temporary-anonymous-ui.md)闭合匿名表单与反馈，SSR/表单26项及构建通过；浏览器点击不据此签收。F2其他出口保持独立。

## Header政策冻结（2026-09-21）

[D1合同1.0.0](./security-header-network-boundary-contract.md)完成D1-01 DOC出口，D1-02转READY。四个实施阶段为编译快照、双向流传输、缓存隔离及迁移防降级；沿用既有叶子，不增加文档任务充数。F3网络矩阵仍为提案，不把政策定稿计为代码完成。

## SDK会话合同（2026-09-21）

[B3-02证据](../audits/2026-09-21-sdk-session-contract.md)固定当前SDK1.29.0矩阵。权限变更下一请求生效，但不自动发送目录通知；真实目录修改有通知阳性对照。父包B3只保留E0依赖，不继续声称SDK矩阵未完成。

## 上游管理界面与恢复（2026-09-21）

[F2-01证据](../audits/2026-09-21-upstream-credential-management-ui.md)完成分区、真实修订和Reload恢复；真实UI适配器接管理HTTP/Registry验证审计错误不等于未激活。F2父依赖保持独立，不能从两叶完成推断整个安全管理面板已签收。

## 四态安全对账合同（2026-09-21）

[F1-01合同](./upstream-security-reconciliation-contract.md)冻结声明、Binding和验证证据的转移/失效规则，已核对OpenAPI3.0.3官方继承与OR/AND语义。相同Binding Revision不保证Provider内容未变，需可信版本关联或发布前重验；门禁代码仍归F1-02。

## Header编译准备（2026-09-21）

[02A证据](../audits/2026-09-21-header-policy-compilation.md)关闭编译准备，02B就绪。父包D1仍未完成，含v1策略不能绕过未就绪门禁进入旧数据面。

## Adapter与B3父出口（2026-09-21）

[当前协议矩阵](../audits/2026-09-21-mcp-adapter-contract.md)关闭E0-01/TP-E0；结合B3两叶已有证据和已闭合B1/B2/E0，TP-B3按原条件DONE。Header编译准备及F1合同仍不等于对应父包完成。

## 上游凭据类型合同（2026-09-21）

[C1-01合同](./upstream-credential-types-contract.md)固定API Key Header/Bearer/Basic/单值Custom Header及明确拒绝类型，定义时间、环境、Host、Endpoint与Method约束，保持F1四态/OR-AND一致。仅静态代码及链接核对；C1-02 READY，未新增运行测试或父包DONE。

## 网络边界政策（2026-09-21）

[F3-01合同§4](./security-header-network-boundary-contract.md)完成DOC：公网/直连默认、精确限期内网例外、DNS全集与连接绑定、TLS/peer写出前复核、限定safe-read跳转与撤销已明确。当前默认未改变；F3-02等待D1-02D4，真实网络矩阵和双平台验收未执行。

## Header双向流执行（2026-09-21）

[02B验收](../audits/2026-09-21-header-wire-execution.md)完成显式compiled路径真实执行：双向过滤、长度/压缩/分块、提前响应、取消及Expect入口边界。联合26套353项，追加后proxy21项与最终API构建通过；专项相互包含不相加。生产激活门禁保持、v1暂禁缓存、main尚未挂入口；02C READY，02D完成接线/迁移后方可启用。8DONE/12IN_PROGRESS/2BACKLOG/1DEFERRED父包计数不变。

## 四类凭据实现与C1闭合（2026-09-22）

[验收证据](../audits/2026-09-22-credential-types-scope.md)关闭C1-02，原SEC-C01与A0条件复核后TP-C1 DONE。Parser27套533项、API联合30套428项、Gateway/显式single-hop真实27项及准备32项均通过；这些计数重叠，不相加。最终API/Parser/Server构建通过；构建发现旧准备器单引用假设已补Basic双引用，没有启用生产IPC。F1-02 READY，父包安全9DONE/11IN_PROGRESS/2BACKLOG/1DEFERRED。（该句记录当时快照；当前状态见第2节。）

## Header缓存隔离（2026-09-22）

[02C验收](../audits/2026-09-22-header-cache-isolation.md)完成必需vary/策略/材料代次、每次命中前预检、原始禁存与真实miss/hit；32项真实HTTP和联合428项通过。02D READY，生产未就绪门禁仍有效，D1/D2父包保持原依赖。

## 2026-09-24 D1-02D重拆与F1-02并行

运行时/快照审查发现原02D横跨Registry同代策略+凭据接线、持久迁移防降级、实际HTTP bootstrap事件安装和冷重启矩阵四出口；旧活动snapshot还校验compiled policy fingerprint，直接默认v1会使旧快照冷启动失败。现把02D替换成D1/D2/D3/D4四个有依赖叶；D1以5套118项完成，D3以2套24项及API构建完成实际入口安装。D2进一步拆为A–D：A以3套57项完成具名legacy期限、未知字段与来源变更拒绝的纯迁移契约/校验器，且未接生产创建入口或持久化，B以6套65项完成两新建入口v1草稿+来源持久写入、旧路由不回填、NOT_READY先行及SQL.js重开；C以3套45项完成显式例外登记/校验/撤销与持久墓碑；D以SQLite与隔离PG联合迁移/冷启动/CAS/撤销/重开4套49项及API构建完成。D4拆为A/B/C：A纯guard与局部真实HTTP 37项DONE，B以5套68项完成授权的生产503守卫接线且零cache/Resolver/upstream绕过；C以14套223项、隔离PG CAS/reopen/expiry/revoke/noActivation完成限定矩阵盘点，逐项证据仍为acceptanceComplete:false；H07冷启动及membership正式正向未闭环。D4D1以3 Parser files、12新增测试、29套557项及build完成Host Store/Registry CAS；D4D2以Entity/service、双迁移、CAS并集/上限/旧库重开、SQLite4套6项、API build及隔离PG zero-drift完成，但不接Provider；D4D3完成Provider/ledger/Registry bridge；D4D4以SQL.js/隔离PG双Node真实HTTP、API组合37项与Parser契约12项完成H07，H11 membership→v1仍未闭环。F1-02进一步拆为A–F：A以17套234项和API构建完成，B以5套57项和API构建完成可信Binding评估与opaque Provider epoch接入，C进一步拆为C1/C2：C1以独立entity/repo、挑战服务、真实挑战与磁盘SQL.js重开14/14完成，F1目录6套71项和API构建通过；C2以SQLite+隔离PG 70表/5迁移冷启/重开/回退零漂移、12套83项、迁移9/9及API构建完成生产证据存储注册；C3拆为C3a–g：a/b/c以4 files、27 tests、API security 8套105项及build完成纯模块，d以独立生产evidence表、双库CHECK/迁移/注册、SQLite/隔离PG 72表/7迁移zero drift及16套120项限定完成，e以真实四阶段loopback/SQLite编排、10套123项及build限定完成，f READY、g等待；生产意图权威/DI/controller/publication未接，无生产Verified闭环。E扩为E1/E2/E3：Gateway E1以39套556项、13项真实HTTP SQL.js重校及API构建DONE但不声明生产Verified；Parser/Transformer E2以Parser28套545项、API102套1116项、Server/API/Parser构建与扩例7/7完成；Verified/custom handlers/E3 managed在线传播未覆盖，E3拆为E3a/E3b：E3a受限ManagedChildSecurityLeaseCoordinator以2 files/7 tests完成，但未注册/未接handoff；E3b运行中更新前阻断、实时授权与事件IPC等待。D等待C3g，F等待D/E3b。总量经既有拆分为149，再由E3增至150、D4A/B/C增至152。两个父包继续IN_PROGRESS。

## 51. D1 H01–H12收口与F1 proof消费边界（2026-09-24）

SEC-D1-H11B以新增真实部署验收完成RuntimeAssets assemble→plan→GatewayCandidateReplay→activate→Nest HTTP/cache全链，33场景覆盖H01–H12，相关73 suites/1023 tests及API build通过。H11覆盖Range/If-*、gzip/identity字节、cache分区及直连/bypass；Proxy只按已验证`requestPolicy.chunked`重建规范化TE，不接受原始值。SQL.js时间精度同秒时保守返回`GATEWAY_CANDIDATE_STALE`，验收等待1050ms后再部署，没有弱化门禁。临时`h11b-matrix.log`与`h11b-regression.log`不属于交付文件，无真实外连。TP-D1据原退出条件转DONE；F1 Verified未接线、inline/legacy/unmigrated/unknown/unsafe继续失败关闭。

SEC-F1-02C3G5仅完成独立Gateway proof消费guard与真实HTTP切片，3 suites/54 tests及API build通过。它未注册module/runtime，缺少生产host challenge/session/proof issuer、同进程authority lifecycle与request-bound capability provider，故从IN_PROGRESS转WAIT_DEP，不开放Verified；E1仍拒绝。
## 52. F3网络执行拆分启动（2026-09-24）

原SEC-F3-02横跨配置/地址分类、受控DNS与连接固定、逐跳凭据/redirect/撤销状态机和双运行时真实网络矩阵，不能由单一纯函数关闭。A限定纯compiler现已DONE：严格v1 Schema、URL/origin、IPv4/IPv6完整分类、mapped归一与精确private-exception已实现；静态IANA表版本为`iana-2025-10-09-conservative-v1`，以后更新必须审查IANA registry差异并重跑地址边界回归。B1现限定DONE：真实UDP 26/26、Parser 31 suites/748 tests及typecheck/build通过，覆盖受信Resolver、A/AAAA/CNAME有界全集、规范化去重、逐地址授权及混合/未分类/截断拒绝；结果仅是DNS批准集合，无上游socket、peer或TLS证据。B2现以31专项、Parser 32 suites/779 tests及typecheck/build限定DONE，仅交付≤8MiB Buffer固定获批IP单跳transport primitive，覆盖真实HTTP/TLS/peer/代理陷阱与Windows Node24；未接Gateway/Transformer host，不支持Readable/大体积流或逐跳撤销。B3继续拆为a/b/c：a现READY，负责Parser共享verified connection、Readable单跳、背压/取消及大于8MiB真实矩阵；b等待a后接Parser host-only可信Site/Registry版本桥和bounded adapter；c等待a后独立接Gateway可信route网络Provider/stream桥，并在C闭合网络身份与撤销前保持缓存关闭。B3聚合与TP-F3继续IN_PROGRESS；C同时依赖b/c，N01–N17双运行时矩阵仍归D，生产启用不得提前。