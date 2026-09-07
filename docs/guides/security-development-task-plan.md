# ApiNova 安全开发任务规划

> Document status: Approved, active execution
> Last reviewed: 2026-09-07
> Scope: 完善现有安全方案；OAuth2 保留为后续产品能力，当前里程碑不开发、不启用
> Implementation status: Batch 1 已启动；执行状态与证据见 [安全开发执行与状态记录](./security-development-execution-status.md)

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
- [MCP 2026-07-28 Specification](https://blog.modelcontextprotocol.io/posts/2026-07-28/)：新版本转向无状态协议并移除旧 Session 交换；升级必须独立规划。

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
