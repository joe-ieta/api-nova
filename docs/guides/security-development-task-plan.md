---
doc-version: 1.80.0
doc-status: active
doc-updated: 2026-09-24
---
# ApiNova 安全开发任务规划

> Document status: Approved, active execution
> Last reviewed: 2026-09-14
> Scope: 完善现有安全方案；OAuth2 保留为后续产品能力，当前里程碑不开发、不启用
> Implementation status: 已按当前实现复核；区分基础实现、未闭环条件和待验证开发。执行状态与证据见 [安全开发执行与状态记录](./security-development-execution-status.md)

> 2026-09-15 调度重排：父包原退出条件不变；当前细分、跨计划归属和下一队列见[工作包划分](./active-work-package-breakdown.md)，逐项状态见[子任务执行台账](./active-work-package-execution-status.md)。父包 IN_PROGRESS 不表示正在同时执行；文档子项完成不计为代码完成。

## 1. 范围决策

本轮只完善 API Key、JWT、Anonymous、上游凭证隔离、动态凭证加载、审计和网络防护。

当前里程碑不支持：OAuth2 Authorization Code、Device Code、Client Credentials、客户端注册、授权/同意页面、Opaque Token Introspection、Token Exchange、On-Behalf-Of、ApiNova Authorization Server。相关类型和 UI 入口仅作未来能力占位，不能创建可执行配置。

JWT 是独立的预配置 Bearer/JWT 校验模式：运维预先配置 Issuer/Public Key 或 JWKS、Audience 和 Claims；ApiNova 只验证 Token，不签发或获取 Token。

## 2. Gateway 与 MCP 隔离

共享控制面：Runtime/Endpoint 身份、Consumer Credential 元数据、Site/Endpoint Upstream Binding、Secret Provider、脱敏、审计、限流和撤销。

隔离数据面：

- Gateway 使用普通 HTTP Route/Method/Policy。
- MCP 由独立 Adapter 处理协议版本、JSON-RPC、Streamable HTTP、SSE 兼容、stdio、Session 或无状态语义。
- Gateway Filter/Interceptor 不直接复用于 MCP JSON-RPC。
- MCP Session ID、Request ID、Tool Name 不能充当身份凭证。
- MCP 自定义 API Key/JWT 属于 Private Deployment Extension，不宣称为标准 MCP OAuth Authorization。

## 3. Anonymous 降级

Gateway 和 MCP 均允许显式 Anonymous，用于开发调试和临时安全测试。

1. Anonymous 不能由未知配置推导。
2. Runtime Policy 必须显式持久化 Anonymous。
3. UI 显示风险、环境、设置人、原因和可选到期时间。
4. 生产启用 Anonymous 需要全局开关与 Runtime 显式策略。
5. 临时 Anonymous 到期后 Fail Closed。
6. Anonymous 仍执行 Host/Origin、大小限制、限流、Tool/Route Allowlist、审计和上游隔离。
7. stdio 由本地进程边界保护，不套用 HTTP 入站认证。

## 4. MCP 协议基线

协议依据：

- [MCP 2025-11-25 Authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)：HTTP Authorization 采用 OAuth Resource Server/Protected Resource Metadata；因此 ApiNova 的 Private API Key/JWT 不宣称为该标准授权实现。
- [MCP 2025-06-18 Transports](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports)：Streamable HTTP 的单 Endpoint、POST/GET、Session 与 stdio 输出边界。
- MCP 后续无状态版本仅是延期升级议题；规范、SDK 支持与互操作须在独立里程碑核实，不能作为当前能力声明。

当前仓库实现和文档以 2025-11-25 Session 语义为主。本文不直接宣布升级到 2026-07，而是要求先建立版本矩阵、兼容策略和 SDK 互操作证据。

### SEC-PROTO-01：协议版本矩阵

- 记录 SDK 实际支持的 MCP 版本。
- 分开记录 2025-11-25 会话路径与 2026-07 无状态路径。
- 未完成专项升级验收前，不隐式切换协议版本。
- 每个 Runtime 声明协议版本和 Transport 能力。

验收：文档、运行配置、版本协商和测试夹具一致，不同时宣称互斥 Session 语义。

### SEC-PROTO-02：Transport 安全适配

- Streamable HTTP 的 Method、Content-Type、Accept、Protocol Header、JSON-RPC Error 保持规范。
- Session 型版本将 Session 与 Principal 绑定并逐请求验证。
- 无状态版本不依赖 Mcp-Session-Id 做鉴权、路由或限流。
- stdio stdout 只输出合法 MCP 消息。
- 旧 SSE 仅作明确兼容模式。

### SEC-PROTO-03：Private Auth Extension

- Private API Key 使用 X-API-Key。
- Private JWT 使用 Authorization Bearer。
- 客户端需预配置 Header，不提供 OAuth Discovery。
- 401/403 保持 HTTP 与 JSON-RPC 边界，不发布虚假 OAuth Metadata。

## 当前实现与批准目标的区别

批准的 SEC 需求与退出条件保持不变；代码已有基础不代表整包完成。状态以[执行台账](./security-development-execution-status.md)为准，不再沿用 2026-09-07 的 Batch 1 快照。

- private_jwt/private_api_key 是 MCP 私有认证产品标签；当前配置仍用 jwt/api_key/anonymous。Gateway 策略引用为 api-key，编译 mode 为 api_key，不直接执行展示标签。
- stdio local_process 是本地信任边界；现有审计缺省身份仍可能为 anonymous，不宣称独立身份字段已实现。
- Gateway 凭证表、Parser 环境 Key、数据库实例 binding 和 Env Header 已有；它们不是完整通用凭证模型或动态 Secret Registry。
- 编译器已拒绝未知策略；本轮补运行时非法对象拒绝，不能以正常编译路径代替非法快照验收。
- Webhook 目的地检查不证明业务 Gateway/MCP 上游已具备完整 SSRF 防护。

## 5. 开发阶段

## Phase A：模式收敛和安全默认值

### SEC-A01：统一枚举

- Gateway：jwt、api_key、anonymous。
- MCP HTTP：private_jwt、private_api_key、anonymous。
- MCP stdio：local_process。
- Runtime 入站只接受 jwt/private_jwt、api_key/private_api_key、anonymous/local_process；开发期数据库直接按新基线初始化，不为旧 oauth 策略提供迁移兼容。

### SEC-A02：Fail Closed 编译

- 删除未知值按环境回退 OAuth/Anonymous。
- 缺失策略：生产拒绝；开发只能由明确 Development Default 生成并持久化 Anonymous。
- Snapshot 保存最终 Auth Mode，请求时不按环境重新解释。

### SEC-A03：临时 Anonymous

- 增加 Allow Anonymous、Reason、Expires At、Created By。
- Gateway/MCP 共享控制面，由各自 Adapter 执行。
- 到期进入 Auth Misconfigured/Blocked，不自动公开。

## Phase B：API Key/JWT 完善

### SEC-B01：统一 Runtime Access Credential

- 基于现有 Gateway Credential 增加 Protocol、Tool Scope、Expires At、Rotation Family、Actor。
- 完整 Key 只展示一次，仅保存 Key ID 和摘要。
- B1-01已实现Protocol/Tool Scope/Subject/Expires At/Actor的统一持久策略和Gateway/MCP共享验证，详见[模型证据](../audits/2026-09-21-unified-consumer-credentials.md)；B1-02已完成Rotation Family、双Key窗口和主机显式database模式逐请求传播，见[在线轮换证据](../audits/2026-09-21-live-rotation-temporary-anonymous.md)。
- 同一 Subject 支持多 Key 无停机轮换。

### SEC-B02：JWT 校验

- 支持固定 Public JWK/JWKS、Issuer、Audience、允许算法、Clock Skew、Required Claims。
- 禁止从 Token 动态选择不受信任 JWKS URL。
- 不实现 Token 获取、刷新、Introspection 或 OAuth Metadata。

### SEC-B03：MCP Principal/Tool 授权

- Private JWT/API Key 每个 HTTP 请求重新验证。
- Session 型版本绑定 Principal；无状态版本使用当前请求 Principal。
- tools/list 过滤，tools/call 二次授权。
- 撤销和过期立即应用。

## Phase C：动态上游凭证

### SEC-C01：YAML/JSON Schema

- 顶层：ApiVersion、Revision、Environment、Reload、Providers、Credentials、Sites。
- Site 使用 Source Service Asset ID 并校验 Scheme/Host/Port/Base Path。
- Endpoint 优先使用 Endpoint Definition ID，Method/Path 仅唯一回退。
- Endpoint 显式配置覆盖 Site；未配置继承；显式 None 关闭认证。

### SEC-C02：Secret Provider

- Env Provider。
- Local File Provider：限制根目录、防穿越、防越界链接、权限、大小和换行策略。
- 预留外部 Provider 接口，本轮不实现。
- 生产拒绝 Inline Secret。

### SEC-C03：Registry 与热加载

- Safe Read、Schema、语义、资产归属、Host Allowlist、Secret 可解析性校验。
- Candidate Dry Resolution 后原子切换。
- 失败保留上一 Active Revision。
- Watch 使用 Debounce/Stable Read；提供受权 Manual Reload 和脱敏状态 API。

### SEC-C04：继承 Resolver

- 优先级：Endpoint Explicit None > Endpoint Credential > Site Credential > Unresolved。
- 输出受控 Request Mutation，不暴露 Sensitive Value。
- OpenAPI 要求认证但 Unresolved 时在联网前失败。

## Phase D：Gateway 数据面

### SEC-D01：Header Policy

- Allowlist 复制业务 Header。
- 删除 Authorization、Proxy-Authorization、X-API-Key、Cookie 和 Hop-by-hop Header。
- Resolver 最后注入上游 Header。
- 本轮不提供 Passthrough。

### SEC-D02：Auth、缓存和限流

- JWT、API Key、Anonymous 三种显式模式。
- 认证模式 Cache Key 包含稳定 Consumer Identity。
- 限流覆盖 Global、Runtime、Route、Credential、IP。
- Anonymous 使用独立 Bucket。

## Phase E：MCP 数据面

### SEC-E01：MCP Upstream Resolver

- Tool 映射 Endpoint Definition ID。
- Tool 调用前授权，调用时使用共享 Upstream Resolver。
- 删除托管进程命令行 Bearer Token，改传 Binding Revision 与 Provider 配置。

### SEC-E02：协议回归

- 分版本测试有状态/无状态、POST/GET/DELETE、SSE/Stream、取消、重连。
- 验证认证失败不破坏 JSON-RPC、stdio stdout、Event Replay 隔离。
- 2026-07 协议升级单独建立里程碑，不夹带在安全实现中。

## Phase F：治理、UI 和运维

### SEC-F01：OpenAPI 对账

- 状态：Unsecured、Declared、Configured、Verified。
- API Key、Bearer/JWT、Basic、Custom Header 与 Binding 兼容检查。
- OAuth2/OpenID Connect 在当前版本标记 Deferred/Unsupported，阻止自动发布且不降级匿名；未来实现时进入独立里程碑。
- OR/AND 不能静默弱化。

### SEC-F02：控制面和 UI

- 分开显示 Consumer Access 与 Upstream Authentication。
- Gateway/MCP 分别显示支持模式与 MCP Private Extension 提示。
- 显示 Anonymous 原因、到期时间和环境限制。
- 显示 Binding Revision、Reload 状态和脱敏错误。

### SEC-F03：审计、SSRF、泄漏防护

- 认证、授权、Reload、Resolve、Rotate、Revoke、Anonymous 开关均审计。
- SSRF 覆盖地址解析、重定向和连接目标复核。
- 日志、异常、CLI 参数、Process Info、测试快照执行 Secret Scan。

## Future Phase G：OAuth2 产品能力

- 当前仅保留类型模型和禁用的 UI 入口，不实现 Token 获取、刷新或客户端注册。
- 后续单独设计授权模式、Provider/Client Registry、加密 Token Store、回调与 Consent、租户隔离和撤销审计。
- 在专项威胁建模、协议互操作和端到端验收完成前，不得将 OAuth2 标记为可用，也不得绕过现有 Fail Closed 发布门禁。

## 6. 验收矩阵

| 场景 | Gateway | MCP |
| --- | --- | --- |
| Anonymous 显式启用 | Route 成功并审计 Anonymous | Tool 成功并审计 Anonymous |
| Anonymous 未显式启用 | Fail Closed | Fail Closed |
| API Key | Runtime/Route Scope | Runtime/Tool Scope |
| JWT | Issuer/Audience/Claims | Audience/Tool Scope |
| 上游凭证 | Site 默认、Endpoint 覆盖 | 同一 Resolver |
| 消费者认证头隔离 | 不透传 | 不透传 |
| 协议错误 | 普通 HTTP Error | MCP HTTP/JSON-RPC 规范 Error |
| 撤销/过期 | 下一请求失败 | 下一请求失败，Session 不绕过 |

必须执行 Unit、Gateway Integration、MCP SDK Integration、Dual Runtime Regression、Secret Leak Scan、Invalid Reload、SSRF、Windows/Linux 验证。

## 7. 依赖与交付顺序

1. SEC-PROTO-01、SEC-A01、SEC-A02。
2. SEC-A03、SEC-B01、SEC-B02。
3. SEC-C01 至 SEC-C04。
4. SEC-D01/D02 与 SEC-E01 可并行，但共用稳定 Resolver Contract。
5. SEC-B03、SEC-E02。
6. SEC-F01 至 SEC-F03。
7. 完整验收后更新能力举证，不以代码存在代替测试证据。
8. OAuth2 在当前安全基础能力完成后另立里程碑，不进入本轮关键路径。

## 8. 完成定义

- OAuth2 可在 UI 保留为禁用的“后续版本”占位，但不能创建、启用、发布或执行。
- Gateway/MCP 均可显式 Anonymous，且不会因错误配置意外匿名。
- API Key/JWT、上游 Credential 和协议身份边界清晰。
- Site/Endpoint Binding 可热加载和原子回退。
- Gateway/MCP 共用上游安全能力，但 MCP 协议适配独立。
- 验收、文档、配置示例与行为一致。

## 9. 与可观测性剩余清单的关系

| 安全任务 | 关联任务 | 共享边界 |
| --- | --- | --- |
| B1/B3/F3 | OBS-TP15/13 | 主体、撤销和拒绝审计；事件/Webhook DONE 不替代安全凭证与 Tool 授权闭环 |
| E0/E2 | OBS-TP06/16 | 复用传输证据但独立验收安全/撤销矩阵；Windows 大响应限制保留 |
| C1~C4/D1/E1 | OBS-TP15 | 上游凭证联网前解析及消费者隔离；调用关联不替代凭证安全 |
| F3/F4 | OBS-TP10/14/16 | Secret Scan、SSRF、留存、平台和部署；真实存活及策略 API 仍待完成 |
| 审计留存治理 | OBS-TP14 | 投递受 14 天/事件到期限制，未满足 FR-10 30 天目标；不撤销 OBS-TP12 既定闭环 |

可观测性状态见[当前完成情况](./runtime-observability-completion-review.md)。26/28 HTTP 已验证、548 项联合通过不能换算为安全任务完成。

## 10. 2026-09-14 首批开发范围与门禁（历史）

先同步文档，再并行推进以下切片，全部 IN_PROGRESS，未验证不标 DONE：

1. A2/D1/F2：Gateway 精确模式白名单、保留 internal Anonymous 既有行为；纠正缺失策略 UI；清理标准和 Connection 声明逐跳头。业务 Allowlist 和完整非法快照矩阵仍待完成。
2. B3：主工具及库注册回调执行前复用当前身份 scope 检查，保持 stdio；tools/list、持久撤销和长连接即时传播不在该切片完成范围。
3. C1：无 I/O 共享配置类型与结构校验，区分 Site 默认、Endpoint 继承/引用/None，拒绝明文和非法引用。第一切片不读文件、不解析 YAML/Secret、不启动 Watch/网络；不支持的凭证类型必须拒绝。

本轮已获得补充拒绝型专项、构建、修正和回归的授权；共享类型错误与旧测试夹具已修正，授权范围内构建和专项均已复验通过。任务包状态不因局部专项通过而提升为 DONE。本轮不隐式授权数据库重建、秘密迁移、重大依赖升级和对外部署。整理前计划与状态见[历史归档](../archive/summaries/security-2026-09-14/README.md)。

## 11. 已验证基础与剩余边界（更新至2026-09-21）

C3 Stable Read 与 Gateway 显式配置激活已实现：Registry 新增 reloadFile，共用对象/文本重载锁；1 MiB 有界双次采样验证文件身份与内容，失败保留旧快照。GatewayRuntimeModule 已注册异步 ConfigService Registry/Resolver Provider，配置有效后启动前激活，无效时拒绝启动；三个配置项均缺省时保留原有 env-headers。原manual基础现已补主机显式启用的固定文件Watch/debounce，坏文件保旧、锁内代次检查和关闭生命周期均通过C3-01验收。

Parser 全量 18 套 342/342、Gateway 完整专项 15 套 123/123（detectOpenHandles）、Parser/Server/API 构建均通过。Gateway 配置激活与 Resolver 独立专项 19/19。扩大回归初次发现的 4 个旧夹具失败已修复，原失败证据保留，最终结果见[执行台账第 18 节](./security-development-execution-status.md)。Parser 全量仍有 4 条既有审计写入告警，Linux Provider 30 个真实文件场景仍未补证。

23 个任务包为 DONE 10、IN_PROGRESS 12、BACKLOG 0、DEFERRED 1。A1三模式保存/发布/重启/请求和stdio身份原退出条件已闭合，证据见[本轮闭环](../audits/2026-09-21-auth-publication-loop.md)。稳定文件读取/配置激活已是已验证切片，不能继续列为缺失；固定源受权Reload/状态API及意图/结果审计已在台账第20节验证，不再列为待开发。现行CLI真实MCP发布启动已验；生产IPC生命周期、Registry配置DB归属现已通过C3-02，剩余多进程、完整凭据/网络政策仍按各自子任务出口完成。

## 12. 当前关键路径与并行面

下表区分实际依赖和当前可执行切片；完整任务包依赖仍以任务表为准，阶段编号不额外引入硬依赖。

| 节点 | 依赖与当前事实 | 推进方式 |
| --- | --- | --- |
| C1 -> C2 -> C3 -> Gateway C4 | 安全文本、Provider、稳定文件源、原子 Registry 与 Gateway 显式配置激活已贯通 | 已验证切片；不新增整包 DONE |
| C4/E1 MCP | E1 依赖 B3/C4/E0；管理侧可信映射、单查询装配、跨源/候选guard已验证；实际受管child启动仍未消费可信绑定/Resolver | 下一关键节点，复用 Registry/Resolver，绑定与身份信息必须来自可信宿主 |
| F3 跳转/网络 | F3 依赖 C4/D1/E1；Gateway及显式single-hop不跟随跳转，Parser legacy保留最多5次；两者保证不能混用 | 与 MCP 集成设计并行；逐跳目标/凭据重建、DNS 与连接授权不得被初始 Site 匹配替代 |
| D1 Header Allowlist | DONE（H11A/H11B限定证据闭合原出口） | Registry-source可信membership经持久v1 marker与trusted compile/validate后原子ACTIVE/snapshot；真实deploy→plan/replay→activate→Nest HTTP/cache 33场景闭合H01–H12，相关73 suites/1023 tests及API build通过。F1 Verified未接线，inline/legacy/unmigrated/unknown/unsafe仍NOT_READY并保旧，无外部部署 |
| C3 管理/Watch/审计 | 启动装载、受权Reload/状态和意图/结果审计已完成；余项为Watch、Registry配置DB归属及多进程 | 独立切片推进；明确失败保旧快照、关闭清理与多进程语义 |
| C2/F4 Linux 证据 | 不阻塞本机纯逻辑开发 | 按隔离测试说明补真实权限结果，不能用 Windows 文件源测试替代 |

D1/F3 的 30 项矩阵见[请求头与网络边界契约](./security-header-network-boundary-contract.md)，D1与F3政策均已定稿，不计为已实现防护。Gateway 的实际配置方式与边界见[文件激活手册](./gateway-upstream-credential-file-activation.md)。

消费者访问链按既有依赖独立推进：A1 -> A2 -> B1，A1 -> B2，B1/B2/E0 -> B3，A2/B1 -> A3；D2 依赖 B1/B2/D1。F4 最终汇合 D2/E2/F1/F2/F3/F3a，局部构建或专项通过不替代完整验收。

B2参数保存/执行与拒绝矩阵已验收，见[本批证据](../audits/2026-09-21-jwt-policy-lifecycle.md)。父包原条件闭合；运行中MCP策略变化须停止后部署。

E0/B3原出口经[Adapter矩阵](../audits/2026-09-21-mcp-adapter-contract.md)及已完成会话撤销/SDK证据复核闭合；Header02B/C/D和F1门禁继续独立推进。

02B受控真实流已完成，详见[验收证据](../audits/2026-09-21-header-wire-execution.md)。F3-02A、B1、B2及B3a/b/c均限定DONE。C1a共享opaque authority与C5a纯失败/审计模块限定DONE。C1b以Parser 38 suites/925 tests、最终C1a+C1b定向2 suites/42 tests、typecheck/build及diff-check限定DONE；C1c以4源码文件、Gateway 43 suites/649 tests、真实HTTP/TLS专项62/62、API build及diff-check限定DONE，完成两侧同一opaque handle、冻结Snapshot/凭据/epoch与总deadline/abort接线，但生产仍默认关闭。C1d的D1 host epoch/提交事件合同已以自身2 suites/16 tests、Parser 41 suites/971 tests（含C2a）、typecheck/build及diff-check限定DONE；D2进一步拆为D2a可信committed ACTIVE route目录/生命周期事件与D2b默认关闭的Gateway Registry/route/epoch/Provider装配；D3 Parser host桥以5 Parser文件、专项20项、Parser42套991项、全量typecheck/build及diff-check限定DONE，source/default-off且缺providerEvidence永拒，WeakMap fixture非生产issuer，不含managed child/E3b与跨进程传播。D2a以SQL.js/旧快照2套42项、Gateway44套664项、API build及diff-check限定DONE；SQL.js dirty-read以同步export到独立query_only副本修复，PostgreSQL未实测、整库复制成本和原候选暂态snapshot行为保留。D2b再拆为b1 immutable host generation store、b2 Registry capture/opaque proof及b3 default-off Gateway/Parser host装配；b1以2个credentials文件、自身23项、统一Parser44套1077项、typecheck/build及diff-check限定DONE，只保存内存有界材料并提供CAS激活/同步撤销到期，无env/file导入、生产issuer或Registry关联，JS string无物理擦除保证；b2 Registry capture/opaque proof以3个credentials文件、专用26项、相邻5套99项、Parser46套1124项、typecheck/build、cleanup及diff-check限定DONE；仅host-owned内存generation→Registry真实Snapshot→一次性source proof，无env/file自动捕获、Gateway生产装配、managed child或跨进程传播。首次TS7006阻断保留历史并已完整复验；b3 READY，D4等待b3/D3。外部Secret Manager、跨进程/E3b与目标环境证据继续归D4/F3D NEED_ENV。C2a以2个独立Parser文件、专项30项及相邻5 suites/240 tests限定DONE；原C2b再拆为b1纯redirect chain state、b2原始Location证据与逐跳真实transport、b3 Transformer显式host配置/生产入口矩阵。b1以2个network文件、专项63项、相邻5套303项、统一Parser44套1077项、typecheck/build及diff-check限定DONE；只处理safe-read空正文GET/HEAD、规范化loop/max5和一次性decision，纯模块不触网/不启用生产入口；b2再拆为b2a rawHeaders唯一Location证据纯模块与b2b逐跳transport；b2b继续拆为b2b1 host-only同代readSignal及b2b2真实多跳transport。b2a以2个network文件、自身21项、相邻3套115项、统一Parser45套1098项、typecheck/build、cleanup及diff-check限定DONE；b2b1以evidence源码/spec两文件、专项2 suites/60 tests、Parser46 suites/1135 tests、typecheck/build、cleanup及diff-check限定DONE，完成同代generation与issuer失效同步AbortSignal、256有界缓存和终态detach；b2b2 READY，b3继续依赖b2b2。消费者仍须映射可信撤销的denied/unavailable，默认保持single-hop且env/file不能激活。C4已解锁READY；C3等D4，C5b等C2b3/C3/C5a，C6最终汇合。真实Provider撤销事件桥、原子revision、生产默认启用、多进程传播、缓存恢复/retry及F3D环境矩阵仍未完成，父F3C/TP-F3保持IN_PROGRESS。

C1原SEC-C01/A0退出条件现已闭合，见[四类型验收](../audits/2026-09-22-credential-types-scope.md)；C1-02完成解锁F1-02，不使F1/E1自动完成。

02C缓存现已完成。原02D已拆为D1 Registry同快照执行接线、D2迁移防降级、D3实际HTTP入口和D4重启/联合矩阵；D1与F1-02安全对账发布门禁并行实施，见[缓存证据](../audits/2026-09-22-header-cache-isolation.md)。
## 13. F1-02真实交付链（2026-09-24）

原F1-02拆为六个真实叶任务：A保留规范化声明、纯四态/OR-AND对账并在发布写入前拒绝，已以17套234项和API构建限定DONE；B以5套57项和API构建完成可信DB/Registry Binding评估、Resolver适配与opaque Provider epoch；C拆为C1/C2：C1以独立entity/repo、挑战服务、真实挑战与磁盘SQL.js重开14/14完成原型，F1目录6套71项和API构建通过；C2以双数据库专用证据存储、prototype kind隔离、70表/5迁移冷启/重开/回退零漂移及12套83项完成；C3进一步拆为C3a上下文authority、C3b挑战transport、C3c proof authority、C3d生产持久evidence kind、C3e挑战编排、C3f安全入口及C3g发布/运行消费者；a/b/c以4 files、27 tests、API security 8套105项及build限定完成，d以生产格式独立evidence表、双库CHECK/迁移/注册、16套120项及SQLite/隔离PG 72表/7迁移zero drift限定完成，e以四阶段loopback→SQLite耐久重读→context/epoch重评→私有proof、10套123项及build限定完成；f以2 files/24 tests、security 10套146项及API build限定完成；g再拆为G1 proof/authorization消费adapter、G2只读preview/readiness、G3单成员DB事务writer、G4批量/verification candidate、G5 Gateway执行proof guard、G6 MCP/child实时许可撤销。G1以30 tests、security 11 suites/176及API build限定完成，G3以2 files、1 suite/10项SQL.js及API build限定完成但未注册/未验PG；G2只读adapter以2 files、2 suites/43及API build限定完成，SQL仅SELECT、实体/evidence零变更且canPublish恒false；G4有界executor切片以3 suites/30 tests及API build限定完成：生产G2默认false/G3零调用，future-readiness fixture仅证明partial commit/continue，candidate仅host-owned同步swap无await，未接异步Registry生产链；D READY；G5独立Gateway proof consumer guard与真实HTTP切片3 suites/54 tests及API build通过，但未注册module/runtime，缺生产host challenge/session/proof issuer、同进程authority lifecycle与request-bound capability provider，故WAIT_DEP且不开放Verified；G4/G5均依赖G1/G3；G6依赖E3b/G1；当前不接production gate，全部F1保护fail-closed。D让preview、单批发布和激活消费同一结果并在事务内复核context，依赖G2/G4；E扩为E1/E2/E3：E1 Gateway每次调用重评guard已以39套556项、13项真实HTTP SQL.js重校及API构建完成，但不声明生产Verified；E2以Parser唯一声明规则与标准HTTP transformer门禁完成，覆盖Parser28套545项、API102套1116项、三构建及扩例7/7；不含Verified/custom handlers/E3 managed在线传播；E3拆为E3a/E3b：E3a受限ManagedChildSecurityLeaseCoordinator已完成但未注册/未接handoff，E3b负责运行中更新前阻断、实时授权、事件IPC及在线撤销；F执行双runtime重开/并发矩阵，依赖D/E3b/G5/G6。父TP-F1保持IN_PROGRESS，A/B完成不能替代C–F的耐久证据和真实运行验收。
D1-02D1/D3、D2A–D及D4A–D4均已有各自限定证据；H11A再以16项真实Controller/Nest/HTTP/cache/SQL.js冷重启联合用例、strict helper 10项、Gateway+Publication 58 suites/778 tests及API build完成Registry-source v1受控激活。全API首轮116 suites/1293 tests中115 suites/1292 tests通过，唯一process-manager.temporary-anonymous suite超时，单跑4/4在12.09s通过且未改测试。F1 Verified未接线，inline/legacy/unmigrated/unknown/unsafe仍fail-closed，无外部部署；H11B以真实部署全链33场景闭合H01–H12，相关73 suites/1023 tests及API build通过，TP-D1按原出口转DONE。