---
doc-version: 1.0.0
doc-status: active
doc-updated: 2026-09-21
---
# 上游凭据类型、生命周期与作用域合同

本文完成 SEC-C1-01（DOC），固定 SEC-C1-02 的实施范围。依据[批准需求](./security-functional-requirements.md)、[安全设计](../reference/security-design-and-implementation.md)、[任务划分](./active-work-package-breakdown.md)，与[四态与发布门禁合同](./upstream-security-reconciliation-contract.md)及[Header 政策](./security-header-network-boundary-contract.md)共同使用。合同定稿不代表新增类型、生命周期或发布门禁已经实现；当前状态见[执行台账](./active-work-package-execution-status.md)。

本文只涉及服务所有者配置的上游凭据。消费者 API Key/JWT、临时匿名和 MCP Principal 不充当上游凭据；消费者认证通过后，才为该次调用解析 Secret。结构文件继续只保存引用，不新增 Secret 数据库、Provider、模板执行器或 OAuth 流程。

## 1. 现有能力与缺口

以下是 2026-09-21 对共享凭据模块的静态核对，不计为新增运行测试。

| 模块 | 已有能力 | C1-02 需补齐 |
| --- | --- | --- |
| [类型](../../packages/api-nova-parser/src/credentials/types.ts)、[Schema](../../packages/api-nova-parser/src/credentials/schema.ts) | apiKey 的 Header placement、bearer，严格未知字段和引用拒绝 | basic、customHeader，逐凭据生命周期与作用域 |
| [Loader](../../packages/api-nova-parser/src/credentials/loader.ts) | 有界 JSON/YAML 到同一 Schema，拒绝危险对象与不支持类型 | 复用现有入口及限制，不另造加载框架 |
| [Registry](../../packages/api-nova-parser/src/credentials/registry.ts) | 环境、资产归属、Candidate 检查、原子快照；按需重新读取 Secret | Basic 双引用完整解析；新类型与约束纳入 Candidate 校验 |
| [Resolver](../../packages/api-nova-parser/src/credentials/resolver.ts) | Site 真实目标匹配、Endpoint 继承/覆盖/None、API Key/Bearer Header 注入 | 类型分支显式穷尽拒绝、时间/Scope 检查、可信 Method 上下文 |
| [Provider](../../packages/api-nova-parser/src/credentials/secret-provider.ts) | Env/File 引用解析及受控错误 | 复用现有非空、长度和控制字符限制；不新增外部 Provider |

当前 Site allowedHosts 与顶层 metadata.environment 已存在，但不能算作逐凭据 Allowed Hosts/Environment；Endpoint 选择器也不等同于 Credential Scope。现有广义认证模型或 legacy Header 注入不证明共享 Registry 已支持 Basic/Custom Header。

## 2. 逐类型决定

“支持目标”表示 C1-02 须实现并验收；“明确拒绝”表示保存为可执行 Binding、激活及执行均不可成功。分析导入可以保留不支持的声明供修复，但不得转换成匿名或换位置继续。

| 类型 | 决定与结构 | 可信请求变更 | 限制 |
| --- | --- | --- | --- |
| API Key Header | 支持目标；保留 `type: apiKey`、`placement: {in: header, name}`、`secretRef` | 指定 Header 的唯一值 | 名称规范为小写；严格匹配声明名称与位置，不添加前缀或模板 |
| Bearer / 预置 JWT | 支持目标；保留 `type: bearer`、`secretRef` | `authorization: Bearer <secret>` | Secret 是原始 Token，不含 Bearer 前缀；JWT 只是上游 Token 格式，不签发、获取、刷新或替上游验证 JWT |
| Basic | 支持目标；新增 `type: basic`、`usernameRef`、`passwordRef` | `authorization: Basic <base64(UTF-8(username + ':' + password))>` | 两个独立 Secret Reference；用户名禁止冒号；不做 challenge 协商或自动重试 |
| Custom Header | 支持目标；新增 `type: customHeader`、`name`、`secretRef` | 一个固定名称的 Header，值来自引用 | 不接受任意 Header 字典、动态名称、多值、插值、前后缀或脚本；与声明的等价映射须由可信配置明确给出 |
| API Key Query | 当前明确拒绝，所有环境均不可执行 | 无 | 保留高风险及生产默认拒绝政策；本轮不开放例外开关，不把 Query 改写为 Header |
| API Key Cookie / Cookie 登录 | 当前明确拒绝 | 无 | 不建立 Cookie Jar，不接收/重放消费者或上游 Cookie |
| OAuth2 / OpenID Connect | Deferred/Unsupported | 无 | 不实现授权码、Client Credentials、获取/刷新、Discovery、Introspection、Token Exchange；不拿预置 Bearer 冒充 OAuth Binding |
| Digest、签名、mTLS、未知 HTTP scheme/未知类型 | 当前明确拒绝 | 无 | 无已批准首期实现，不增加“自定义类型”逃生口 |
| None / inherit / Unresolved | Binding 选择状态，不是 Credential 类型 | None 不注入；inherit 先解析最终选择 | 受保护声明不能因 None/缺失/失败降级匿名 |

Header 名必须通过共享语法和保留名政策。Basic/Bearer 只由专用类型生成 Authorization；C1-02 应拒绝 API Key/Custom Header 使用 authorization 绕开专用类型。禁止托管 Cookie、Set-Cookie、Proxy-Authorization、逐跳/framing、代理生成与协议控制字段；禁止用 Custom Header 覆盖 D1 保留字段。普通 API Key x-api-key 可由 Resolver 重新注入，入站同名值仍必须剥离。旧配置若使用新禁止名称，Candidate 明确拒绝并保留旧有效快照，不静默改名或忽略。

Basic 用户名、密码都按 Secret 处理，沿用 Provider 的非空和安全文本限制；空用户名/密码、CR/LF/NUL、超限内容明确拒绝。本轮不放宽 Provider 支持空 Secret。输入必须可按 UTF-8 确定编码，非法 Unicode 拒绝；编码结果仍受出站单字段/总 Header 大小限制。Basic Base64 可恢复原值，禁止把它当作脱敏文本。

## 3. 生命周期及作用域字段

四种支持目标共用下列可选字段。C1-02 扩展现有 v1 Schema，并在规范化结果中固定默认语义；不能在每次请求时从不可信参数改变默认值。未提供新字段的现有合法 v1 引用保持既有 Site/Endpoint 边界；显式 null、空数组、非法日期、未知字段不视为省略。

| 字段 | 格式及省略语义 | 执行要求 |
| --- | --- | --- |
| enabled | 布尔；省略为 true | false 禁止使用，不回退 Site/另一凭据 |
| notBefore | 带时区、有效 ISO 8601 时间，规范化 UTC；省略无下界 | 主机当前时间小于该值时拒绝；等于时可以继续 |
| expiresAt | 同上；省略无上界 | 当前时间大于或等于该值时拒绝；存在双界时须 notBefore 小于 expiresAt |
| environment | 单个环境标识，采用现有环境规范化；省略继承顶层环境 | 必须同时匹配 Candidate 与可信宿主环境；不能由请求、Header 或 Tool 参数指定 |
| allowedHosts | 非空精确 Host 数组，复用现有 Host 规范化；省略沿用 Site 边界 | 与 Site allowedHosts、真实 scheme/host/port/basePath 匹配取交集；禁止通配符，不授权额外目标 |
| endpointDefinitionIds | 非空唯一 Endpoint ID 数组；省略不额外缩小 Site/Binding 的 Endpoint 范围 | 请求可信 Endpoint ID 必须在集合内；缺 ID 时拒绝，不从 operationId/调用参数猜测 |
| methods | 非空唯一 HTTP Method 数组，规范为现有受支持大写 Method；省略不额外缩小已绑定范围 | 实际出站 Method 必须在集合内；缺少可信 Method 时拒绝 |

所有限制同时满足才可解析使用，覆盖只替换凭据选择，不取消所选凭据自己的 Scope。Credential 引用于多个 Site 时，在每个引用位置分别校验归属和目标，不能借一个 Site 的成功验证授权另一个 Site。Host 限制是精确目标匹配，不证明 DNS/SSRF、重定向或连接 IP 已获授权；这些仍属 F3。

现有 Resolver 将 Endpoint ID 与 Method/Path 回退选择视为互斥。C1-02 必须区分“Endpoint 选择器”与“可信实际出站 Method”：使用 ID 时也能检查 Method Scope，不得为了传入 Method 同时启用第二个 Endpoint 选择器。字段命名可由实现统一，但输入必须由可信 Adapter 从已绑定 Endpoint 和实际执行请求生成，不能信任调用者自报。

时间检查使用宿主时钟，并在异步 Secret 解析完成、注入返回前复核；不可只在 Reload 时检查，否则激活后自然到期不会生效。测试用受控时钟覆盖边界，生产不能通过配置文件注入时钟。撤销通过成功激活 enabled: false 或取消引用生效；下一次解析使用当前快照，旧在途请求不承诺召回。跨进程传播仍需 C3/E1 验收，不能以单进程结果声称全局即时撤销。

## 4. Reload、解析与脱敏

1. 保留既有 Safe Read、JSON/YAML、Schema、语义、资产归属、环境、Provider 和原子切换流程。未知类型、字段、坏引用、非法时间范围、Scope 结构错误拒绝 Candidate，旧 Active Snapshot 不变。
2. 合法但禁用、未来生效或过期的凭据可以作为不可用配置激活，便于撤销与预置；它们不因此成为 Configured/Verified。结构、归属、引用与 Provider 的既有 Candidate 校验仍执行，不把禁用字段变成秘密校验旁路。已过期等使用状态由请求解析拒绝，不能因为将“凭据禁用”误判为非法 Candidate 而继续使用旧有效凭据。
3. Basic 两个引用必须全部成功解析并校验，才能一次性生成 Header；任一失败不输出部分凭据、不尝试另一引用或类型。Registry 现有 resolveSecret(id): string 不能默认承载两项材料；实现应增加类型明确的内部解析结果或专用双引用接口，并保持控制面状态只返回非敏感元数据。
4. Provider 内容每次使用重新解析，不能无限缓存 Secret。Basic 若两份外部材料分开更新，Provider 不承诺跨文件事务；运营轮换应发布两个新引用并原子切换 Binding Revision，不能把双读取宣传成跨文件原子性。
5. 消费者认证头和所有当前/已登记历史托管名先剥离，再由 Resolver 注入。None、类型切换、删除凭据也不能恢复旧认证名透传；新增 customHeader 名必须进入托管名集合。普通业务 Header allowlist 不授权认证名。
6. 失败仅返回稳定安全原因与非敏感配置定位。日志、响应、审计、状态、进程参数、测试快照不得记录 Secret、用户名/密码、Authorization、Base64 或原始 Provider 异常。引用定位也不得夹带 Secret 内容。测试材料只能在隔离上游内部比较，不写入测试失败快照。

运行时原因至少可区分 CredentialInactive（禁用/未生效/过期）、ScopeMismatch、SecretUnavailable、BindingIncompatible、Unsupported；最终错误枚举可沿用现有命名并建立映射。新增类型必须显式穷尽分支，不能保留“非 bearer 一律当 apiKey”的默认注入。所有拒绝场景在业务联网前失败。

## 5. 与 F1 四态及组合的衔接

类型识别和 Secret 可读不等于认证成功。Unsecured 仍要求明确无凭据选择；受保护声明缺少兼容可用 Binding 时是 Declared；类型、生命周期、Scope、所有引用合法才满足 Configured 的必要条件；只有当前上下文成功认证证据才是 Verified。声明、所选分支、目标、引用、生命周期、Scope 或 Provider 内容变化，使旧验证失效，依照 F1 重新对账/验证。

API Key Header 按名称和位置精确兼容；Bearer/JWT 只兼容 http/bearer；Basic 只兼容 http/basic。Custom Header 只能在可信映射明确等价时兼容，不能按相似名称猜测。None 与受保护分支冲突、引用解析失败、类型拒绝都不得变成 Unsecured。

OR 必须显式选择完整分支，不在失败时自动切换；AND 必须完整表达并同时满足。现有单 Credential Binding 无法表达多个独立 Scheme 时返回 CombinationUnsupported，本轮不引入组合凭据 DSL。Basic 与 Bearer 同占 Authorization 等冲突，即使值相同也拒绝。有效声明引用 OAuth2/OpenID Connect 时按 F1 既定政策阻止自动发布，包括混合 OR/匿名分支；未引用的 OAuth Scheme 不使其他 Endpoint 被误判为 OAuth。

C1-02 提供类型/约束解析与拒绝证据；F1-02 实现声明、四态、验证证据及发布门禁。不能把 C1 类型单测当作 F1 完成，也不能倒置依赖形成循环。真实受管 MCP 通路仍依赖 E1，C1 的进程内 Resolver 结果不能替代它。

## 6. C1-02 有界实施及出口

| 顺序 | 实施切片 | 必须交付的验收 |
| --- | --- | --- |
| 1 | 复用现有 Schema/类型，增加 Basic、单值 Custom Header 和公共约束 | 纯对象、JSON、YAML 一致；四类正例；全部拒绝类、未知字段、明文和引用错误；旧合法 v1 示例仍通过 |
| 2 | Registry 类型化 Secret 解析与 Resolver 类型穷尽 | Basic 两引用任一失败无部分注入；真实隔离上游验证编码；Custom Header 唯一注入；新/旧托管名均隔离 |
| 3 | 可信宿主 Method/Endpoint 适配、生命周期/Scope | ID+实际 Method 同时约束；时间边界及异步跨到期；环境/Host/Endpoint/Method 正反例；成功禁用阻断下一次解析 |
| 4 | 接入既有 Gateway/显式共享 Resolver 通路并回归 | 每类上游真实收到正确认证且消费者值不泄漏；拒绝时上游命中零；坏 Candidate 保旧、合法禁用激活、Provider 变化与秘密扫描 |

四切片属于同一 C1-02 实施任务；若按并行开发再拆编号，应同步工作包划分与台账，不能仅因拆分增加完成数。无需重做已完成 loader、Safe Read、Watch 或平台 ACL；不引入新数据库秘密存储、外部 Provider、Query 例外、OAuth、自动重试或管理 UI。

最终报告须逐项区分纯逻辑、Gateway 真正联网、显式 Parser/MCP 共享路径和受管 MCP 生产路径证据。尚待 E1 的部分明确列依赖，不把 C1-02 完成写成 C4/E1/F1 父包闭合。C1-01 本身只做合同、源代码对照和引用校验，不新增测试通过数量。
