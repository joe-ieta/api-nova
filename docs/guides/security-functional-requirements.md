# ApiNova 安全功能需求

> Document status: Draft for approval
> Last reviewed: 2026-09-07
> Implementation status: 已批准并进入 Batch 1；以 [执行状态记录](./security-development-execution-status.md) 为准

## 安全模型

最终调用者以 ApiNova API Key/JWT 访问 Runtime；ApiNova 使用服务所有者配置的上游凭证调用被注册 API。消费者正常情况下不知道也不提供上游凭证。身份透传与 Token Exchange 不在当前产品范围。

## 总体原则

1. 发布不等于公开；生产默认受保护。
2. Gateway 支持 API Key、JWT、显式 Anonymous；MCP 支持 Anonymous 及私有部署 API Key/JWT，并保持独立协议适配；未知策略 Fail Closed。
3. 消费者凭证和上游凭证在存储、配置、日志、运行上下文中隔离。
4. 缺少上游凭证时禁止以消费者凭证替代或默认透传。
5. Secret 不进入 OpenAPI、样本、证据、普通结构文件、日志或进程命令行。
6. 配置版本化、完整校验后原子激活、可审计且失败可回退。

## 功能要求

### 管理和消费者访问

- 凭证创建、绑定、轮换、撤销及 Runtime 发布/启停要求 JWT 与明确权限；Secret 只写，变更完整审计。
- 消费者 Key 只显示一次，持久化 Key ID 和 Secret 摘要。
- 新生产 Runtime 默认 API Key；Key 支持 Runtime、Protocol、Route/Tool Scope、有效期、轮换、撤销。
- 首选 Authorization Bearer ApiNova-Key，兼容 X-API-Key；Query Key 默认禁用。
- JWT 校验 Signature、Issuer、Audience、Exp、Nbf 和授权 Claims。
- MCP Session 绑定 Principal、Credential ID、Runtime Asset ID、Policy Revision；Tool 列表过滤且每次调用重新授权。

### 上游凭证

- 动态加载结构化凭证文件，不能只支持环境变量参数。
- 支持 Site 默认凭证和 Endpoint 覆盖；Endpoint 未配置时继承 Site。
- 文件只保存 Secret Reference；生产禁止 Inline Plaintext Secret。
- 首期 Provider 支持环境变量和受保护本地 Secret 文件；接口可扩展但本轮不实现外部 Secret Manager。
- Endpoint 优先按 Endpoint Definition ID 匹配，Method/Path 仅作严格唯一回退。
- 优先级为 Endpoint 显式 None 或 Endpoint Credential、Site Credential、Unresolved；歧义或缺失必需凭证时拒绝。
- Credential 支持 Enabled、Not Before、Expires At、Environment、Allowed Hosts 和 Endpoint/Method Scope。
- 消费者授权成功后才解析 Secret；转发前删除消费者 Authorization、Proxy-Authorization、X-API-Key、Cookie。
- 上游认证头只由可信 Resolver 注入；Reload 校验 Candidate 后原子切换，失败保留上一 Revision。

### 注册 API、网络和运营

- 解析 OpenAPI 全局和 Operation Security，状态区分 Unsecured、Declared、Configured、Verified；OAuth2/OpenID Connect 在当前版本标记 Deferred/Unsupported，不自动降级，未来通过独立产品里程碑启用。
- 受保护 Endpoint 只有在兼容凭证可解析且验证成功后才可发布；认证 OR/AND 不能静默弱化。
- Query API Key 标记高风险，生产默认拒绝。
- 外部 Gateway/MCP 使用 TLS；独立 MCP 默认 Loopback；保留 Host/Origin、DNS Rebinding、CORS 防护。
- 实施 SSRF 防护、分层限流、认证日志脱敏和安全事件。

## 结构文件和 UI

结构文件是 Binding 文档而不是 Secret 数据库，包含 Schema Version、Revision、Environment、Providers、Credentials、Sites、Endpoint Overrides、Reload Policy。Site 使用 Source Service Asset ID 并校验 Scheme/Host/Port/Base Path；Endpoint 使用 Endpoint Definition ID，可继承、替换或显式关闭 Site Credential。

发布页分开显示“消费者访问”和“上游认证”，不得把上游 Bearer 标注为 MCP Client Token。详细 Schema 见 [安全设计与实现方案](../reference/security-design-and-implementation.md)。

## 验收

必须证明消费者 Key 不传给上游；消费者无需知道上游 Secret；继承覆盖正确；无效 Reload 保留旧 Revision；缺失 Secret 在联网前失败；撤销同时阻断 Gateway/MCP；未知策略不变匿名；日志、证据、命令行无完整 Secret；受保护 Endpoint 未验证时不能成为 Verified。

## 当前能力摘要

| 能力 | 状态 | 缺口 |
| --- | --- | --- |
| 管理 JWT/RBAC | 已实现 | Secret 权限和完整审计 |
| Gateway Anonymous/JWT/API Key | 已实现，Batch 1 加固待审核 | 临时 Anonymous 元数据和统一凭证模型 |
| Gateway Key 摘要、Scope、撤销 | 已实现 | 有效期、轮换、Protocol/Tool Scope |
| Gateway Env Header 注入 | 已实现 | 动态结构、继承、Header 隔离 |
| OpenAPI Security 提取 | 分析已实现 | Configured/Verified 闭环 |
| MCP 上游 Bearer/Custom Header | 已实现 | 共享 Resolver、移除命令行 Secret |
| MCP 入站 API Key/JWT | Private JWT/API Key 基线已实现 | 统一凭证管理和完整协议版本回归 |
| Site/Endpoint 继承 | 未实现 | 必须补齐 |
| OAuth2 | 后续产品能力 | 当前仅保留类型模型和禁用 UI 占位，不可创建、发布或执行 |
| 完整 SSRF | 未举证 | 生产阻断项 |

