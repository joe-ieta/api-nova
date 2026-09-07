# ApiNova 安全设计与实现方案

> Document status: Draft for approval
> Last reviewed: 2026-09-07
> Implementation status: 已进入实现；Batch 1 状态见 [安全开发执行与状态记录](../guides/security-development-execution-status.md)

## 架构

Consumer Credential 与 Upstream Credential 是不同对象。Gateway/MCP 共享控制面策略、Secret Provider 和 Upstream Credential Resolver，但 MCP 保持独立协议适配。结构文件保存 Binding 与 Secret Reference，不作为 Secret 数据库；Site 提供默认凭证，Endpoint 显式覆盖；现有 env-headers 作为首期 Provider。OAuth2 保留为后续产品能力，当前只保留类型模型和禁用 UI 占位，不参与解析、发布或运行。

目标组件：RuntimeAccessCredentialService、ConsumerAuthorizationService、UpstreamCredentialRegistry、SecretProviderRegistry、UpstreamCredentialResolver、GatewaySecurityAdapter、McpSecurityAdapter。

## 开发期数据库基线

- SQLite 与 PostgreSQL 各自从单一 canonical baseline 初始化，实体共享、SQL 方言分别表达。
- 开发阶段不提供旧表、旧枚举或历史快照的数据迁移；结构调整后重建开发数据库。
- `db-compat.ts` 只负责 JSON/Enum/UUID/Timestamp/IP 等双引擎方言映射，不承担版本兼容。
- OAuth2 枚举和结构类型作为未来扩展位保留，但当前 UI 禁用，发布和运行路径拒绝；不为历史 OAuth2 数据增加兼容分支。
- 上游 Secret 继续存放在受控 Provider 中，数据库和 Binding 文件只保存引用、摘要及非敏感元数据。

## 动态结构

推荐 YAML 作为运营格式，以 JSON Schema 强校验；JSON 使用同一 Schema。

~~~yaml
apiVersion: security.apinova.io/v1
kind: UpstreamCredentialBindings
metadata:
  revision: orders-prod-2026-09-04-01
  environment: production
reload:
  mode: watch
  debounceMs: 1000
  rejectPlaintextSecrets: true
secretProviders:
  processEnv: { type: env }
  localSecrets:
    type: file
    root: /etc/apinova/secrets
    requireOwnerOnly: true
credentials:
  orders-service:
    type: apiKey
    placement: { in: header, name: X-API-Key }
    secretRef: processEnv:ORDERS_API_KEY
  orders-admin:
    type: bearer
    secretRef: localSecrets:orders-admin-token
sites:
  - id: orders-prod
    sourceServiceAssetId: 3d76b45d-0000-4000-8000-000000000001
    match: { scheme: https, host: orders.internal.example, port: 443, basePath: /api/v1 }
    credential: orders-service
    allowedHosts: [orders.internal.example]
    endpoints:
      - endpointDefinitionId: 4e87c56e-0000-4000-8000-000000000001
        credential: orders-admin
      - method: GET
        path: /public/health
        credential: none
~~~

Secret Reference 格式为 provider:key。首期 Env 和受限目录 File；File Provider 防目录穿越、越界链接、不安全权限和异常内容。生产拒绝 Inline Secret。

## 匹配、继承和加载

1. 获取不可变 Active Snapshot。
2. 按 Asset/Instance 定位 Site，校验真实 Scheme、Host、Port、Base Path。
3. 按 Endpoint Definition ID 优先、唯一 Method/Path 回退定位 Endpoint。
4. Endpoint 有 Credential（含显式 None）则使用，否则继承 Site。
5. OpenAPI 要求认证但仍 Unresolved 时联网前失败。
6. Provider 解析 Secret，删除消费者认证头，再注入上游认证头。

优先级：Endpoint Explicit None > Endpoint Credential > Site Credential > Unresolved。Endpoint 默认整体替换认证，不隐式拼接 Site Secret Header。

Reload 流程：安全读取、Schema 校验、语义和资产归属校验、Provider 检查、构建 Candidate、Dry Resolution、原子切换、审计。无效 Candidate 不改变 Active Snapshot；Watch 使用 Debounce 与 Stable-read。

## Gateway 和 MCP 接入

Gateway 顺序：路由解析、消费者认证授权、流控、上游 Binding/Credential 解析、复制允许业务头、删除消费者认证头、注入上游凭证、转发和脱敏审计。默认 Replace；None 不注入；Passthrough 仅未来显式委托模式。

MCP 按选定协议版本处理有状态或无状态语义：有 Session 的版本绑定 Principal，无状态版本逐请求使用当前 Principal。Tool 列表过滤，Tool 调用逐次授权。Tool 通过 Endpoint Definition ID 使用共享 Resolver。Anonymous 可显式启用；API Key/JWT 属于需要客户端预配置 Header 的 Private Deployment Extension，不宣称为标准 MCP OAuth Authorization。托管 MCP 最终只传 Binding Revision/Provider 配置，禁止命令行 Bearer Token。

## OpenAPI 对账

Endpoint 从 Declared 到 Configured 再到 Verified。API Key Header、Bearer/JWT、Basic、Custom Header 必须与 Binding 兼容。OAuth2/OpenID Connect 在当前版本标记 Deferred/Unsupported。空 Operation Security 表示显式匿名。Security Array 对象间为 OR，单对象多 Scheme 为 AND；不支持的组合拒绝而非降级。

## 能力举证

| 能力 | 结论 | 代码举证 |
| --- | --- | --- |
| 管理 JWT/RBAC | 已实现 | [runtime-assets.controller.ts](../../packages/api-nova-api/src/modules/runtime-assets/runtime-assets.controller.ts) |
| Gateway 三种入站模式 | 已实现 | [gateway-security.service.ts](../../packages/api-nova-api/src/modules/gateway-runtime/services/gateway-security.service.ts) |
| Key 摘要、Scope、撤销 | 已实现 | [gateway-consumer-credential.entity.ts](../../packages/api-nova-api/src/database/entities/gateway-consumer-credential.entity.ts) |
| 未知策略 Fail Closed | 已实现，待审核 | [gateway-policy.service.ts](../../packages/api-nova-api/src/modules/gateway-runtime/services/gateway-policy.service.ts) 对缺失、未知和旧模式拒绝编译 |
| Env Header Reference | 已实现 | [RuntimeCredentialRef.ts](../../packages/api-nova-parser/src/headers/RuntimeCredentialRef.ts) |
| Gateway Header 隔离 | 部分 | [gateway-proxy-engine.service.ts](../../packages/api-nova-api/src/modules/gateway-runtime/services/gateway-proxy-engine.service.ts) 先复制入站 Header |
| Site/Endpoint Registry | 未实现 | 未发现 Active Resolver |
| OpenAPI Security 分析 | 已实现 | [security-extractor.ts](../../packages/api-nova-parser/src/extractors/security-extractor.ts) |
| 广义 Auth 数据模型 | 仅模型或部分 | [auth-config.entity.ts](../../packages/api-nova-api/src/database/entities/auth-config.entity.ts) |
| MCP 上游 Bearer | 已实现 | [auth.ts](../../packages/api-nova-server/src/cli/auth.ts)、[bearer-auth.ts](../../packages/api-nova-parser/src/auth/bearer-auth.ts) |
| MCP 入站认证/Tool 授权 | 基线已实现，待完整协议回归 | [httpServer.ts](../../packages/api-nova-server/src/tools/httpServer.ts)、[runtime-security.ts](../../packages/api-nova-server/src/tools/runtime-security.ts) |
| Secret 不进 MCP 命令行 | 未实现 | [server-lifecycle.service.ts](../../packages/api-nova-api/src/modules/servers/services/server-lifecycle.service.ts) 仍可传 Bearer Token |
| Access Log 认证元数据 | 已实现 | [gateway-access-log.service.ts](../../packages/api-nova-api/src/modules/gateway-runtime/services/gateway-access-log.service.ts) |
| OAuth2 | 后续能力占位 | 类型模型保留；UI 禁用；当前写入 DTO、发布和运行拒绝 |
| 完整 SSRF Policy | 未举证 | 生产阻断项 |

## 实施阶段和审核项

1. Gateway 边界闭合、Header 清理、Schema/Loader、Env/File Provider、Site/Endpoint Resolver。
2. MCP 入站认证、Session Principal、Tool Scope、共享 Resolver、移除命令行 Secret。
3. 轮换、异常检测、外部 Secret Provider（另行批准）。
4. OAuth2 与 Token Exchange 另立后续产品里程碑，复用已完成的 Provider、审计、租户和 Secret 基础能力。

编码前审核：YAML+JSON Schema；Env/File 首期范围；新 Runtime 默认 API Key；Query Key 处置；是否完全禁止认证头透传；MCP 协议版本基线与 Private Auth 兼容范围。

