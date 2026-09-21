---
doc-version: 1.0.0
doc-status: active
doc-updated: 2026-09-21
---
# 上游安全对账与发布门禁契约

本文完成 SEC-F1-01，冻结批准需求的四态、OpenAPI OR/AND、Binding 兼容和发布拒绝规则，是 SEC-F1-02 的实施输入。**合同定稿不代表四态持久化、发布门禁或两运行时执行已经实现**。功能进度以[执行台账](./active-work-package-execution-status.md)为准。

规范来源：[安全功能需求](./security-functional-requirements.md)、[安全设计](../reference/security-design-and-implementation.md)、[任务划分](./active-work-package-breakdown.md)。消费者 API Key/JWT/Anonymous 与上游认证独立；消费者认证成功不能提升上游状态，消费者 Anonymous 不能跳过上游门禁。

## 1. 有效声明

Operation 的 security 存在时整体覆盖 Root，缺失才继承；空数组移除继承要求；数组成员互为 OR，单成员的多个 Scheme 是 AND，空对象表示匿名备选。依据 [OpenAPI 3.0.3 Operation Object](https://spec.openapis.org/oas/v3.0.3.html#operation-object) 与 [Security Requirement Object](https://spec.openapis.org/oas/v3.0.3.html#security-requirement-object)。下面的发布限制属于 ApiNova 产品政策。

| 原始声明 | 必须保留的有效含义 |
| --- | --- |
| Operation 缺失，Root 有 security | 继承 Root，保存 global 来源和原表达式 |
| Operation 有非空 security | 整体使用 Operation，不与 Root 合并 |
| Operation 为 `security: []` | 显式无上游认证，记录 operation-explicit-empty，不回退 Root |
| 两级缺失或继承 Root 空数组 | 无认证声明，分别保留 absent/global-explicit-empty；不能据此证明真实上游无需认证 |
| `security: [{}]` | 显式匿名备选，保留空分支 |
| `security: [{Key: []}, {}]` | 同时保留 Key 与匿名分支，不因凭据缺失自动选匿名 |
| `security: [{A: [], B: []}]` | A、B 必须同时满足，不能只取第一个 |
| `security: [{A: []}, {B: []}]` | 可以明确选择一个完整分支，不要求同时满足两个 |
| null、非数组、非法成员、未定义 Scheme、未解析引用 | 无效/未解析，拒绝发布，不得当作空或缺失 |

以可信 Source Service Asset ID、Endpoint Definition ID 和规范版本标识操作；重复 operationId 不能覆盖别的 Endpoint。导入必须保留全局声明与 Scheme 定义，仅存 rawOperation 不足以恢复继承。未被有效表达式引用的 OAuth Scheme 不使普通 Endpoint 变成 OAuth Endpoint。

## 2. 四态

四态是当前上下文的计算结果，可以退回，不复用 EndpointDefinitionStatus.VERIFIED 或发布 Profile 的业务状态。另存声明来源、选中分支、阻断原因与证据引用。无效输入不得显示为 Unsecured。

| 状态 | 条件 | 发布意义 |
| --- | --- | --- |
| Unsecured | 有效声明允许匿名，且明确选择无凭据路径，没有被忽略的解析/政策错误 | 仍须通过业务验证、消费者访问、网络及其他发布门禁 |
| Declared | 受保护声明或已选择认证分支，尚无完整兼容且可解析的 Binding；解析错误附具体原因 | 拒绝发布，缺少、冲突、None、Unsupported 不降级匿名 |
| Configured | 所选分支全部要求匹配 Binding，归属/目标/环境/作用域/生命周期合法，Secret 当前可解析 | 未获当前成功验证，拒绝受保护发布；配置保存不是认证成功 |
| Verified | Configured 条件仍成立，当前上下文有可追溯的成功上游认证验证 | 可进入其他门禁，运行时仍重新解析并执行拒绝 |

匿名可选表达式必须保存所选分支；认证失败、Secret 缺失不能自动切换空分支。显式选匿名仍保留完整表达式和选择审计。无认证声明但显式绑定凭据的路径，按该 Binding 经过 Configured/Verified；同时保留“声明未要求认证”的事实，不能把额外 Secret 注入当作无条件安全。

稳定阻断原因至少区分 DeclarationInvalid、DeclarationUnresolved、BindingMissing、BindingIncompatible、BindingAmbiguous、SecretUnavailable、CredentialInactive、ScopeMismatch、CombinationUnsupported、OAuthUnsupported、VerificationMissing、VerificationFailed、VerificationStale。具体传输码由 F1-02 统一，本合同不声称已有这些代码。

## 3. Binding 选择与类型兼容

先校验资产归属及真实 Scheme/Host/Port/Base Path，再应用 Endpoint Explicit None > Endpoint Credential > Site Credential > Unresolved。Endpoint 覆盖整体替换 Site，不暗中拼接 Secret。

| 最终选择 | 条件 | 结果 |
| --- | --- | --- |
| Endpoint 未配或 inherit | Site 有完整兼容凭据 | 使用 Site，继续配置/验证检查 |
| Endpoint reference | Site 也有凭据 | 只用 Endpoint，记录覆盖来源 |
| Endpoint/Site none | 明确选择无认证路径 | Unsecured，仍清除消费者/托管认证头 |
| Endpoint none | 受保护分支没有匿名选择 | Declared + BindingIncompatible，None 不解除声明要求 |
| Unresolved | 受保护分支 | Declared + BindingMissing，联网前拒绝 |
| Unresolved | 无认证声明 | 发布配置明确保存无凭据决策；Adapter 不得捕获 Resolver 错误后回退匿名 |
| 引用缺失、归属/目标错误或歧义 | 任意声明 | 拒绝，不尝试其他实例或借用其验证 |
| Secret 不可读、禁用/未生效/过期、环境或 Method/Endpoint Scope 不符 | 认证分支 | 不满足 Configured，业务联网前拒绝 |

| 声明类型 | 兼容要求 | 首期边界 |
| --- | --- | --- |
| apiKey/header | API Key Header 或明确等价 Custom Header；名称大小写不敏感精确匹配，不改变位置 | 仍执行 Header 保留字段和冲突政策 |
| http/bearer | Bearer/JWT 令牌型 Binding，由 Resolver 生成 Authorization Bearer | bearerFormat JWT 不代表签发、刷新或校验上游 Token |
| http/basic | Basic 专用 Binding，完整用户名/密码引用与正确编码 | 依赖 C1-02，不能用 Bearer 或任意 Header 冒充 |
| Custom Header | 可信的名称、位置、Scheme 映射，符合批准类型 | 非 OpenAPI 内置类型；不发明扩展语法，不按名称猜认证 |
| API Key Query | 不改写成 Header 获得兼容结论 | 高风险，生产默认拒绝；未明确实现验收的例外仍拒绝 |
| Cookie、未知 HTTP scheme、其他未批准类型 | 无已批准兼容 Binding | Unsupported，拒绝发布/执行，不扩展 C1 范围 |
| OAuth2/OpenID Connect | 当前没有可用 OAuth Binding | OAuthUnsupported，阻止自动发布，不拿 Bearer Secret 冒充 OAuth 能力 |

有效表达式含 OAuth2/OpenID Connect 时，首期按批准禁用政策阻止自动发布，包括与支持类型或匿名分支混合的情况；不能删去 OAuth 分支绕过。未引用的 Scheme 不触发此门禁。改变此政策须经过独立 OAuth 里程碑。

OR 选择稳定、显式、可审计，发布记录保存原表达式及所选分支。AND 必须完整满足并注入所有 Scheme；当前单 Credential 引用不能表达时返回 CombinationUnsupported，不能部分执行，也不能拿任意 Header 集合声称已验证。Basic 与 Bearer 同写 Authorization 等冲突必须拒绝，相同值也不消除语义冲突。失败不自动尝试其他 OR 分支；重新选择属于配置变更并要求新验证。

## 4. 转移与验证失效

| 事件 | 结果 |
| --- | --- |
| 导入受保护声明，无匹配 Binding | Declared |
| 补齐兼容配置和可解析 Secret | Configured |
| 当前分支真实上游验证成功并存证 | Verified |
| 业务样本成功，没有认证分支/Binding 证据 | 最多 Configured |
| 当前认证验证拒绝、超时、网络失败 | Configured + VerificationFailed，不得发布 |
| Verified 后 Secret/生命周期失效 | Declared + 具体原因，拒绝新发布及相关调用 |
| 声明/分支/Binding Revision/目标变化，配置仍合法 | Configured + VerificationStale，重新验证 |
| 声明显式取消认证，经受权操作选择无凭据 | Unsecured，审计并通过其他发布检查 |
| Registry Candidate 失败，旧 Snapshot 未变 | 旧配置和证据不因此失效，不提升新 Candidate |

证据上下文至少绑定 Source/Endpoint、真实目标、声明摘要/来源、选中分支、Binding Revision/代次、凭据引用、环境/Scope、验证时间/主体/结果引用。验证经过实际调用使用的 Resolver 与 Header 隔离路径。401/403、超时、缺少凭据、无法判断认证结果不是成功；普通业务成功也不能单独证明使用了正确凭据。证据须确认可信注入，隔离测试须证明上游实际检查凭据。

Provider 内容可以在相同 Revision 下变化。F1-02 必须用可信且非敏感的 Provider 版本/变更标识关联证据，或发布前重新验证，不能无限复用只绑定 Revision 的 Verified。Secret、Authorization、Basic 编码或可恢复的 Secret 派生材料不得进证据、日志、错误或列表。旧验证迟到、并发发布必须检查同一上下文，不能将旧成功覆盖到新配置。

## 5. 发布和执行门禁

1. 导入/写入时检查声明结构与支持性，保存完整有效表达式及来源；允许保存受阻草稿，不生成可执行发布状态。
2. 单项、批量、Gateway、MCP 和自动配置/启动入口共用安全对账。受保护路径须当前 Verified，匿名路径须明确选择且符合政策；预览/readiness 与实际发布共用结论。
3. 增加 publication revision、激活路由/成员或启动前复核上下文未变；失败不激活候选，不以半写入候选替换已有发布。批次沿用既定事务语义，但每个成员均须安全检查。
4. 运行时当前解析优先于旧发布状态。缺失 Secret、失效凭据、Unresolved、None 与保护要求冲突时业务联网前拒绝。此门禁不替代 Header、DNS、redirect、连接地址检查。
5. 返回受控原因和修复指向，审计主体、Endpoint、Revision/代次与失败阶段，不返回 Secret/原始认证响应，不以消费者凭据补偿上游失败。

## 6. 当前实现及后续接入点

以下为 2026-09-21 静态检查，不是新增运行验收。

| 代码 | 可复用部分 | 缺口 |
| --- | --- | --- |
| [SecurityExtractor](../../packages/api-nova-parser/src/extractors/security-extractor.ts) | Root/Operation 提取及分析告警 | 四态、兼容/分支选择、严格错误、空对象语义及门禁；当前跳过 Scheme 引用不代表匿名 |
| [类型](../../packages/api-nova-parser/src/credentials/types.ts)、[Schema](../../packages/api-nova-parser/src/credentials/schema.ts) | API Key Header/Bearer、Site/Endpoint 选择 | Basic/Custom Header、生命周期/Scope 由 C1-02 闭环，不能从合同推断支持 |
| [Registry](../../packages/api-nova-parser/src/credentials/registry.ts)、[Resolver](../../packages/api-nova-parser/src/credentials/resolver.ts) | Snapshot、归属、继承/None、Secret 解析 | Resolver 输入无有效 OpenAPI 表达式；当前 None 返回空 Header 不自行核验声明 |
| [Endpoint 实体](../../packages/api-nova-api/src/database/entities/endpoint-definition.entity.ts) | rawOperation/metadata 和业务状态 | 独立四态、全局来源和认证证据，不能复用业务 VERIFIED |
| [PublicationService](../../packages/api-nova-api/src/modules/publication/services/publication.service.ts) | buildReadiness、publishMembershipContext 和现有业务验证 | 增加共用安全门禁、所有入口及提交前复核；现有 readiness 不是本合同实现 |

F1-02 依次实现有效声明规范化/纯对账器、可信 Binding/Provider 适配及证据、持久化与单/批量门禁、两运行时拒绝与真实集成验收。切片均属同一代码任务，出口未齐备不标 DONE。

依赖固定为 **SEC-F1-01 + SEC-C1-02 → SEC-F1-02**。C1-02 依赖 C1-01，交付批准类型的解析、注入、脱敏、拒绝、生命周期和作用域。本合同不反向成为 C1 依赖，不制造循环。F1-01 完成只解除文档依赖，C1-02 未完成时 F1-02 仍 WAIT_DEP。SEC-C4-01 还依赖 SEC-E1-03 真实受管 MCP 通路，不能以单进程 Resolver 测试代替。

## 7. F1-02 验收矩阵

| 类别 | 必须覆盖 |
| --- | --- |
| 声明 | 全局继承/覆盖、空数组/空对象、混合匿名、重复 operationId、非法结构、未解析引用、缺少 Scheme |
| 兼容 | Header 名称/位置、Bearer/JWT、Basic、Custom Header 正反例；None/Unresolved/继承/覆盖/跨源/目标错配 |
| 组合 | OR 明确选完整分支，AND 全满足/缺一项/冲突/不支持；OAuth 单独/混合/未引用 |
| 生命周期 | 禁用、Not Before、到期、环境/Method/Endpoint Scope、同 Revision Secret 变化、解析失败、坏 Candidate 保旧 |
| 验证竞态 | 真正校验凭据的隔离上游，401/403/超时；旧成功迟到、变更复核、失效、单/批量拒绝无新激活 |
| 两运行时 | 同声明/Binding 在真实 Gateway/MCP 一致；失败上游命中零、无消费者凭据泄漏 |
| 持久化脱敏 | 重开后来源/证据一致，适用的 SQLite/PostgreSQL 验证；响应/日志/审计/失败快照无 Secret |

F1-01 仅做合同与引用检查，不计新运行测试通过数，也不使 F1 父包完成。
