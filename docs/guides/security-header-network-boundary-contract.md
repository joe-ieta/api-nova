---
doc-version: 0.3.0
doc-status: draft
doc-updated: 2026-09-14
---
# D1/F3 请求头与网络边界契约

本文定义 D1 业务 Header allowlist 与 F3 redirect/DNS/SSRF 的兼容策略和验收边界。当前能力以实现引用为依据；D1/F3 目标规则仍为提案，不代表已上线能力，也不改变默认网络策略。

## 1. 范围与证据

安全计划 SEC-D01 要求按 allowlist 复制业务 Header，删除消费者认证及逐跳字段，由 Resolver 注入上游凭据，本轮不提供凭据 Passthrough。SEC-F03 要求覆盖地址解析、重定向和连接目标复核，以及审计与秘密泄漏防护。本文只展开 Header 与业务出站网络边界，不替代 F3 全包生命周期审计、CLI 秘密治理或 Secret Scan。

| 证据 | 使用的位置 |
| --- | --- |
| [安全计划](E:/CodexDev/api-nova/docs/guides/security-development-task-plan.md) | SEC-D01、SEC-F03、第 12 节依赖与并行切片 |
| [Gateway 代理](E:/CodexDev/api-nova/packages/api-nova-api/src/modules/gateway-runtime/services/gateway-proxy-engine.service.ts) | `forward`、`resolveCredentialHeaders`、`buildForwardHeaders`、`buildForwardedForHeader`、`normalizeResponseHeaders` |
| [Gateway Resolver 适配](E:/CodexDev/api-nova/packages/api-nova-api/src/modules/gateway-runtime/services/gateway-upstream-credential-resolver.ts) | `createGatewayUpstreamCredentialResolver`、`GatewayUpstreamCredentialHeaders` |
| [Gateway 策略类型](E:/CodexDev/api-nova/packages/api-nova-api/src/modules/gateway-runtime/types/gateway-policy.types.ts) | `GatewayCompiledPolicyBundle`、缓存 `varyHeaderKeys`、上游策略 `raw` |
| [稳定文件读取](E:/CodexDev/api-nova/packages/api-nova-parser/src/credentials/file-source.ts) | 有界双采样、文件身份与内容检查、链接及 UTF-8 校验 |
| [Gateway 凭据 Provider](E:/CodexDev/api-nova/packages/api-nova-api/src/modules/gateway-runtime/services/gateway-upstream-credential.providers.ts) | ConfigService 异步 Registry/Resolver factories、显式配置激活与失败关闭 |
| [文件凭据激活运行手册](E:/CodexDev/api-nova/docs/guides/gateway-upstream-credential-file-activation.md) | 配置要求、manual 模式、启动与 legacy 兼容边界 |
| [执行台账第 18 节](E:/CodexDev/api-nova/docs/guides/security-development-execution-status.md) | 构建、专项与回归验证记录及最新计数 |
| [纯 Resolver](E:/CodexDev/api-nova/packages/api-nova-parser/src/credentials/resolver.ts) | `target`、`siteFor`、`selectionFor`、`resolveUpstreamCredential` |
| [旧 Env Header 解析](E:/CodexDev/api-nova/packages/api-nova-parser/src/headers/RuntimeCredentialRef.ts) | `resolveRuntimeCredentialRefHeaders`、`BLOCKED_HEADERS` |
| [Parser 网络请求](E:/CodexDev/api-nova/packages/api-nova-parser/src/transformer/index.ts) | `executeHttpRequest` 的 Header 构造与 Axios 配置 |
| [Parser 跳转观测](E:/CodexDev/api-nova/packages/api-nova-parser/src/audit/runtime-http-agent.ts) | `createRuntimeHttpAuditAgents` |
| [已有 Header 用例](E:/CodexDev/api-nova/packages/api-nova-api/src/modules/gateway-runtime/services/gateway-proxy-engine.credential.spec.ts) | 消费者凭据剥离、Connection 动态字段、业务头保留、Env 注入 |
| [已有 C4 用例](E:/CodexDev/api-nova/packages/api-nova-api/src/modules/gateway-runtime/services/gateway-upstream-credential-resolver.spec.ts) | 快照适配、托管 Header、None、固定 503、旧 Env 回退 |

当前实现见上表所列代码与运行手册。构建、专项和回归的最新结果统一见[执行台账第 18 节](E:/CodexDev/api-nova/docs/guides/security-development-execution-status.md)，本文不复制验证计数或临时进度。

### 1.1 当前 C3 与默认 Provider 能力

- 已新增 `reloadFile(path, format)`，受统一重载锁保护；使用有界双采样稳定读取，限制 1 MiB、采样间隔 50 ms，检查 file stat/identity/content，拒绝 links 和非法 UTF-8。
- GatewayRuntimeModule 已注册基于 ConfigService 的异步 Registry/Resolver factories。显式 `API_NOVA_UPSTREAM_CREDENTIAL_FILE`、`API_NOVA_UPSTREAM_CREDENTIAL_FORMAT`（`json|yaml`）、`API_NOVA_UPSTREAM_CREDENTIAL_ENVIRONMENT` 三项齐备且有效时，在 bootstrap 前激活。
- 三项均未配置时保持 legacy；只配置部分、值非法或加载失败时拒绝启动。仅支持 manual 模式，watch 配置文件拒绝加载。不能把稳定读取称为已实现自动 Watch。

上述 C3 能力不自动提供 DNS/SSRF、redirect 每跳复验、业务 Header allowlist 或整条跳转链固定版本。

## 2. 已实现的行为和限制

### 2.1 Gateway Header

`buildForwardHeaders` 当前是剥离清单，不是业务 allowlist：

1. 聚合入站所有大小写形式的Connection键，支持字符串和数组，按逗号拆分、去空白、转小写并忽略空项。
2. 剥离 `connection`、`keep-alive`、`proxy-authenticate`、`proxy-authorization`、`te`、`trailer`、`trailers`、`transfer-encoding`、`upgrade`、`host`、`authorization`、`x-api-key`、`cookie`，以及 Connection 声明字段和托管凭据字段。匹配不区分大小写。
3. 其余非空值全部复制，包括未声明的 `x-business`；数组统一 `join(',')`。普通业务输出键保留输入拼写；四个代理生成字段x-forwarded-host/proto/for、x-request-id会先移除所有大小写别名，再由生成器写入唯一值。不能宣称普通业务头已统一小写或检查全部重复冲突。
4. `Object.assign` 注入受信任凭据，再写入目标 `host`、`x-forwarded-host`、`x-forwarded-proto`、`x-forwarded-for`、`x-request-id`。准确顺序是“凭据在业务头之后、代理元数据之前”。

`x-forwarded-for`通常保留客户端传入值并追加socket remoteAddress；若Connection提名该字段，则只使用peer地址，不重新引入已剥离的客户端值。`x-forwarded-host` 来自入站 Host，`x-forwarded-proto` 来自 req.protocol 或目标 scheme。这里没有建立这些值可用于身份或 IP 授权的保证。`forwarded` 等未在剥离清单中的字段仍可能透传。

入站 `content-length` 未列入剥离清单，正文通过 PassThrough 转发。不能由此推导请求走私已解决。响应侧 `normalizeResponseHeaders` 仅规范化值，未实施同等逐跳头剥离；D1 请求头成果不代表双向完整隔离。

### 2.2 凭据

有注入 Resolver 时，`forward` 在创建上游 request 前等待解析；解析错误固定映射到 503，消息为 `gateway_upstream_credential_unavailable`。这项错误映射不覆盖未注入适配器时的旧 Env 分支。

Gateway 适配器每次 resolve 捕获一个快照，用 source asset、目标 URL 和 endpoint ID 调用纯 Resolver。托管 Header 名包括 authorization 和候选中所有 API Key placement 名，不限于当前选中的凭据。因此 None 分支仍可清除其他候选认证头。集合不包括已从候选移除的历史自定义 Header，不能证明未知或历史认证名全部被剥离。

没有注入 Resolver 时，代理仍使用实例 credentialRef 的旧 `env-headers` 分支，其托管名来自本次解析结果。旧解析器校验语法、重复名、部分传输字段、值长度和 CR/LF，不检查 Site、DNS 或连接地址。其 BLOCKED_HEADERS 不包含 cookie，故“剥离消费者 Cookie”不等于“可信配置不能注入 Cookie”。统一禁止托管 Cookie 等新约束需要兼容决定。

纯 Resolver 校验 HTTP/HTTPS、URL 用户信息和 fragment、尾点 hostname、部分编码路径及控制字符，按 asset、scheme、host、有效端口、allowedHosts 和 base path 边界匹配 Site，优先选最长 base path。Endpoint None 返回空 Header，引用或继承由快照解析。allowedHosts 在这里是 hostname 字符串匹配，不是 DNS 地址白名单，也不独立授权列表中任意主机。纯 Resolver 不做 DNS、网络、重定向授权或连接目标复核。

### 2.3 网络路径不能混同

| 路径 | 代码可证明的现状 | 不具备的证明 |
| --- | --- | --- |
| Gateway | 原生 http.request/https.request 单跳；响应状态、Header、流返回客户端；redirectHopIndex 为 0，不跟随 Location | 不跟随不是拒绝或清洗 3xx，也不证明初始 URL 有 SSRF 防护 |
| Gateway DNS/连接 | 向原生请求传入 hostname/port；所读调用未设置安全 lookup、IP 分类或地址固定 | 不证明公网/私网限制、重绑定防护或部署级代理策略 |
| Parser | 顺序合并默认头、操作 Header 参数、自定义头、Env 凭据、authManager；Axios 显式 maxRedirects: 5、validateStatus: () => true | 此函数没有每跳 C4 复验或安全 Header 重建，不能依赖自动跳转推导自定义凭据不会泄漏 |
| Parser 观测 | 有运行 context 才创建操作级 HTTP/HTTPS Agent；按原生请求递增 hop，attemptIndex 为 1 | Agent 只是观测包装，未来安全检查必须在无 context 时同样生效 |
| Parser DNS/代理 | 所读 Axios 配置未设置安全 lookup、beforeRedirect 或显式 proxy 策略 | 未审查第三方传输实现或部署配置，不断言代理环境变量实际行为及跨域删头细节 |

Webhook 目的地策略不能替代业务路径的证据，其政策不能直接作为业务默认值。

## 3. D1 业务 allowlist 兼容提案

本节都是待实现契约，所述模式不是现有可加载配置或已经定义的 Schema。

### 3.1 业务清单

建议使用“有版本的基础业务集合 + Site/Endpoint 精确扩展集合”。编译时规范化名称，禁止 *、x-* 等通配符。Endpoint 未声明扩展则继承 Site；显式扩展替换 Site 扩展；空扩展表示仅基础集合。未知头在新策略启用后剥离，认证头永远不能靠业务清单恢复。

| 类别 | 建议兼容策略 | 前置条件 |
| --- | --- | --- |
| accept、accept-language、content-type、content-encoding | 建议基础允许，保持值与真实正文编码一致 | 不推导网关存在正文转换能力 |
| accept-encoding | 建议基础允许 | 流式透传与缓存命中均需证明压缩语义一致 |
| if-match、if-none-match、if-modified-since、if-unmodified-since、if-range、range | 建议基础允许，保留条件请求和分段下载 | 缓存正确区分语义，或相关请求 bypass；未经验证不算兼容完成 |
| cache-control、pragma | 建议基础允许 | 透传不证明 Gateway 缓存遵循这些指令 |
| idempotency-key、prefer、x-business、版本/租户/业务关联头 | Site/Endpoint 精确声明后允许 | 不允许所有 x-；租户头不替代 Principal；幂等键不授权自动重放 |
| origin、referer、user-agent | 按上游兼容需求显式声明 | 不作可信身份；避免无需求传播来源信息 |
| traceparent、tracestate、baggage | 独立追踪规则，初版不自动加入基础集合 | 限长、脱敏，外部关联与内部身份分离，尤其不默认传播 baggage |
| authorization、proxy-authorization、x-api-key、cookie、托管认证名 | 入站禁止，业务配置冲突则拒绝激活 | 仅 Resolver 受控输出可注入上游凭据，无消费者回退 |
| 标准逐跳字段及 Connection 声明字段 | 剥离优先于业务清单 | 即使 connection: accept，也剥离入站 Accept；可信凭据注入独立执行 |
| host、x-forwarded-*、forwarded、x-request-id | 保留给代理生成器，禁止作为普通扩展 | 明确可信代理来源，不能复制任意客户端链后称为可信 |
| content-length、transfer-encoding、expect、Trailer/Upgrade | 传输层单独处理，不作为业务扩展 | 明确长度、流、取消及 100-continue，不能只删长度而保留错误 framing |

### 3.2 迁移与执行优先级

1. 使用已授权离线夹具或脱敏证据统计 Header 名，生成每个 Site/Endpoint 的差异清单，只记录名称/数量，不记录值，也不自动将观察到的未知名加入白名单。
2. 审核扩展、缓存和传输兼容后显式启用新策略版本，通过原子快照发布；失败保留旧快照。迁移须保持未启用新策略的既有路由行为。
3. 新版本按 allowlist 执行，缺失或非法配置拒绝激活；旧版本保留及退役时间另行确定。迁移未完成不能标 D1 完成；旧业务兼容不等于授权消费者凭据 Passthrough。

执行顺序提案：

1. 名称统一小写，校验 token、数量、大小和 CR/LF；拒绝大小写重复的凭据/framing 歧义；仅对明确允许逗号列表的字段合并多值，其余逐字段定义。
2. 剥离消费者认证、候选托管认证名、逐跳字段，再与业务 allowlist 取交集。历史或未知认证名因不在清单而删除；禁止未审阅就将历史认证名复用为业务扩展。
3. 重建代理元数据与正确 framing。XFF 可信前缀只来自明确可信代理；改变当前追加行为需单独兼容决定。
4. 目标网络授权成功后应用 Resolver 凭据；拒绝凭据输出占用 Host、framing、逐跳或代理保留字段。None 不恢复消费者值。业务头不能覆盖凭据，凭据不能改变连接目标。
5. 向审计提供敏感 Header 名、安全原因和版本，禁止把凭据值写入日志、异常或快照。

值校验、多值规范、可信代理及输出冲突拒绝不是当前 buildForwardHeaders 已实现能力。旧 Env 可注入 Cookie 等差异应在迁移时明确报错，不能静默改变旧配置含义。

## 4. F3 每跳网络与凭据提案

### 4.1 策略与默认值

网络授权属于实际请求层，不能塞入无网络 I/O 的纯 Resolver。网络策略与凭据策略均通过，才可携凭据发送。None/Anonymous 不豁免网络检查；可访问的目的地不代表可携带任意 Site 凭据。

Gateway 保持不自动跟随 Location。Parser 当前最多五次跳转作为兼容基线；加入每跳守卫或关闭自动跳转均需显式政策和验收。本文不把 maxRedirects 改零，也不自动启用 Gateway 跳转。

建议明确选择公网限制配置或有批准依据的内网例外。公网配置拒绝非公网目标；内网例外绑定 source asset、精确 origin、允许地址/CIDR、端口、用途和审阅信息。不能自动禁止所有私网而破坏本地上游，也不能因为支持内网就放开任意私网。公网默认适用范围及例外格式是落地前阻塞决策。

### 4.2 每次发送前的状态机

适用于首次请求、允许的 redirect 下一跳及 retry 新连接：

1. 固定逻辑操作的凭据/网络策略版本，规范化目标 URL，校验 scheme、userinfo、端口和路径。Location 相对当前 URL 解析；非法 Location 拒绝，fragment 处理需与目标 URL 契约一致。字符串前缀不替代 Site/base path 授权。
2. 对真实目标重新授权 source asset、Site、Endpoint 和网络目的地。scheme/host/port 任一变化即 origin 变化；同源跳出 base path 或进入更具体 Site 也必须复验。
3. 取得最终地址的 A/AAAA 全集，规范化并分类每个 IP；直接 IP URL 同样处理。混合公开/禁止地址默认整次拒绝，不能只选一个公网地址。DNS 超时、空答案、非法结果失败关闭。
4. 将允许的具体地址绑定到本次连接，保留逻辑 Host、TLS SNI 和证书 hostname 校验，禁止校验后无约束二次解析。连接复用需证明 peer 仍满足本次授权，新连接/重试重新验证。
5. 从可信业务模板重建 Header，清除上一跳托管凭据及消费者凭据；网络授权和当前目标解析均成功后才注入目标凭据。失败不回退旧凭据、Env 或消费者值。
6. 响应触发下一跳前检查跳转政策、跳数、总时限、循环、取消和正文重放。真实发送记录一致逻辑操作 ID 与正确 hop/attempt；拒绝记录原因/版本，不伪造已发送节点。

直接连接应在任何 HTTP Header/正文写出前核对 peer。不能在写出前核对的传输实现需禁止复用该连接或提供等效保证。错误输出不能包含凭据或带敏感查询的原始 URL。

当前 Gateway 适配每次 resolve 自行捕获快照，返回 Header 和名称，没有跨跳固定快照句柄。纯 Resolver 虽返回 revision/generation/siteId，Gateway 适配返回值未保留这些字段。因此整链固定版本需新增接口，不能把一次 resolve 的保证扩展为整链保证。紧急撤销是否打断在途链也需明确，不能隐式混用版本。

### 4.3 地址、代理、凭据和正文

| 边界 | 待实现规则 |
| --- | --- |
| IPv4 | 公网配置覆盖 RFC1918、loopback、link-local、unspecified、共享地址、组播、广播及其他保留/不可路由范围；采用完整分类库或表并锁定版本，不仅检查 127./192.168. |
| IPv6 | 覆盖 ::、::1、ULA、link-local、组播及保留范围；IPv4-mapped IPv6 按内嵌 IPv4 分类；zone ID/转换地址不得绕过 |
| 非标准 IP | 十进制整数、八/十六进制、缩写 IPv4 等统一规范化分类或显式拒绝，不能仅当普通域名 |
| DNS 重绑定 | 检查与连接 IP 绑定；CNAME 最终地址、A/AAAA 混合、连接池复用均需覆盖；TTL 缓存不替代连接授权 |
| 代理环境 | 明确 HTTP(S)/ALL_PROXY、NO_PROXY 政策；本机 DNS 不能证明代理实际目标。代理支持需证明代理端目标限制和 CONNECT/origin 授权，或在显式安全模式拒绝不可验证路径；不静默改变旧环境行为 |
| 跨 origin | 不沿用旧 Authorization/API Key/自定义凭据/Cookie；仅目标的显式绑定及授权可注入目标凭据。跨 asset 授权另定，不能从新 hostname 推断资产 |
| 同 origin 不同路径 | 重新检查 base path/Endpoint，不能把初始 endpoint ID 套在 Location 上 |
| HTTPS 降级 HTTP | 建议安全配置拒绝；例外需显式且审计。纯 Resolver 已能匹配 HTTP Site，当前不是全局禁用 HTTP |
| 301/302/303 | 明确各状态的 method/body 改写规则，和 Axios 当前行为做兼容验收；跳转不等于业务重试 |
| 307/308 | 请求体可安全重放且政策允许才重发；不可重放流拒绝跟随，禁止空正文补发。换凭据不消除向未授权目标泄露正文的风险 |

## 5. 可执行验收矩阵

本矩阵定义验收要求，不声明 30 项均已通过。“已有用例”表示存在相应断言；“缺口”指所列代码路径未实现该防护；“提案”待实现后作为退出条件。实际执行结果统一见[执行台账第 18 节](E:/CodexDev/api-nova/docs/guides/security-development-execution-status.md)。

离线夹具：Site A 为 https://a.example/api，属于 asset A；Endpoint P 使用 synthetic-a，Endpoint N 显式 None；Site B 为 https://b.example/api，使用 synthetic-b。URL 仅作内存输入；mock Resolver、DNS、HTTP(S) request、Agent/socket 和 Axios adapter，不访问真实 DNS/网络或真实 Env 秘密。记录 resolveCalls、lookupCalls、connectCalls、writeCalls、发送 Header、正文摘要及审计事件。使用可注入时钟和流桩模拟超时、取消、部分发送与跳转。

| ID | 输入/操作 | 必须断言 | 状态 |
| --- | --- | --- | --- |
| H01 | 大小写混合 Authorization/X-API-Key/Cookie/Proxy-Authorization | 消费者值不出站，有绑定时只出现当前合成凭据 | 已有用例；结果见执行台账 |
| H02 | Connection 字符串/数组/重复名/空项，声明业务和认证头 | 入站声明字段全剥离；可信凭据仍可注入；trailer/trailers 分别断言 | 现有逻辑，部分已有用例 |
| H03 | x-business 未在 allowlist | 当前基线保留，新策略启用后剥离；两种夹具分开 | 基线已有用例；提案 |
| H04 | Endpoint 扩展缺失/空/替换 Site | 分别继承/仅基础/基础加 Endpoint 扩展；拒绝通配符和非法名 | 提案 |
| H05 | allowlist 含凭据/逐跳/代理保留名 | 拒绝激活，旧快照有效，无网络调用 | 提案 |
| H06 | None 且携带其他候选的认证名 | 候选托管名剥离，不注入凭据 | 已有用例；结果见执行台账 |
| H07 | 轮换后删除旧自定义认证名 | 新策略剥离未允许的旧名；基线显式暴露当前剥离清单局限 | 缺口/提案 |
| H08 | 大小写重复/重复单值/CR-LF/多值 Accept | 按字段规则拒绝或合并，无重复凭据和 framing 歧义 | 提案；当前统一逗号合并 |
| H09 | 伪造 XFF/Forwarded/request-id，可信代理启停 | 当前 XFF 保留前缀作基线；新政策只用授权来源构造链，身份不采用伪造值 | 现状+提案 |
| H10 | 固定长度/分块/空体/Expect/取消 | framing 和实际字节一致，无双 framing、二次消费或空体重放 | 待传输契约 |
| H11 | Range/If-*/Accept-Encoding 不同而路径相同，随后缓存命中 | 状态/Header/正文与直连语义一致；缓存隔离或 bypass 有证据 | 提案，依赖 D2 |
| H12 | Resolver 错误/None/旧 Env/非法 Env | Resolver 错误固定 503 且 connectCalls=0；旧 Env 分支独立断言，不错误套用固定 503 | 部分已有用例；联网前断言待补 |
| N01 | Gateway 收到 302/307 与 Location | 仅一次 request，返回状态/Location，hop=0，无下一跳 | 代码基线待执行 |
| N02 | Parser 第五和第六次跳转 | 锁定 maxRedirects=5；第六次跟随失败；有无 context 跳转行为一致 | 配置已有，用例待执行 |
| N03 | 初始 scheme/host/port/base path/asset 不匹配 | C4 联网前拒绝，allowedHosts 不能单独放行 | Resolver 逻辑待执行 |
| N04 | 相对 Location 到同 Site 有效 Endpoint | 每跳复验、重建 Header，仅目标凭据出站，hop 递增 | 缺口/提案 |
| N05 | 同源跳出 /api、到 /api-evil 或 None Endpoint | 越界拒绝；有授权的 None 不携带前跳凭据；不复用初始 endpoint ID | 缺口/提案 |
| N06 | A 到 B，或 host/port 改变；目标有/无授权 | 无授权无下一跳连接/写出；有授权仅 B 凭据，Header/正文无 A 秘密 | 缺口/提案 |
| N07 | HTTPS 降级/userinfo/非法 scheme/循环/超跳数 | 按显式政策拒绝，无下一跳写出；错误无敏感 URL | 首跳部分已校验，逐跳缺口 |
| N08 | DNS 返回 10.0.0.1、127.0.0.1、169.254.169.254、0.0.0.0、100.64.0.1 | 公网配置逐地址拒绝，connectCalls=0 | 缺口/提案 |
| N09 | ::、::1、fc00::1、fe80::1、::ffff:127.0.0.1、组播、zone ID | 公网配置拒绝；规范化变体不绕过 | 缺口/提案 |
| N10 | 2130706433、0x7f000001、127.1 等 URL | 规范化后拒绝 loopback，或准入直接拒绝该表示法 | 缺口/提案 |
| N11 | A/AAAA 混合允许与禁止地址，CNAME 最终私网 | 整次拒绝，无连接；不只检查第一地址 | 缺口/提案 |
| N12 | DNS 先允许后私网、peer 不同、复用旧 socket | 连接绑定验证地址；peer 不符 writeCalls=0；复用不绕过授权 | 缺口/提案 |
| N13 | 内网 origin/IP/端口例外，再改其中一项 | 仅明确范围成功；相邻地址和未授权跳转失败；不改普通部署默认 | 提案，策略阻塞 |
| N14 | mock 代理环境/NO_PROXY/代理 DNS 变化 | 代理不绕过目标验证；显式安全模式不可证明则拒绝；无真实代理访问 | 提案，代理语义阻塞 |
| N15 | 307/308 不可重放流；301/302/303 POST | 不可重放不二次写；按批准规则断言 method/body；拒绝目标无正文写出 | 缺口/提案 |
| N16 | 两跳间 reload/revoke，retry/DNS 超时/取消 | 版本一致，重试复验连接，取消后无写出，撤销规则独立断言 | 提案，快照/撤销阻塞 |
| N17 | 每种场景有/无 context | 安全结果一致，观测失败不放宽政策，被拒跳不伪造发送 | 提案 |
| L01 | 全矩阵使用合成消费者/A/B 秘密，收集日志/异常/审计/快照 | 消费者秘密不出站，A 秘密不进入 B，采集输出无合成秘密，含安全原因/版本 | 待执行，不替代全量 F3 Scan |

网络拒绝分阶段断言：URL/策略/DNS 拒绝要求 connectCalls=0；peer 复核拒绝允许已建连但要求 writeCalls=0。不能用“最后 HTTP 报错”代替联网前或写出前证据。若 mock Agent 无法观测真实发送时点，该项仍未覆盖，不得用 mock 返回值宣布通过。

本地集成验收使用受控 HTTP/HTTPS/代理服务器验证 TLS、真实 socket、缓存、重放与平台差异，无需访问生产秘密或公网服务。

## 6. 依赖与退出条件

| 依赖 | 阻塞退出条件 | 责任边界 |
| --- | --- | --- |
| C3 稳定读取和显式配置激活（已实现） | 以 reloadFile 和启动工厂作为接入基线，不作为缺失能力阻塞 D1/F3 | 实现与操作见稳定文件读取、Gateway 凭据 Provider 和运行手册；验证见[执行台账第 18 节](E:/CodexDev/api-nova/docs/guides/security-development-execution-status.md) |
| C4 适配/配置校验 | 托管名、保留字段冲突、目标 Endpoint 身份、整链版本和撤销语义 | 共享 Resolver/适配接口；纯 Resolver 保持无网络 I/O |
| D1 编译 Schema 与迁移决定 | allowlist 配置来源、版本、继承/替换、非法拒绝和兼容差异 | 后续 D1 实现；本文不是可执行配置 |
| D2 缓存与传输 | 条件/范围/压缩头、framing、可信代理和重放规则闭合 | Gateway 数据面集成 |
| E1 MCP 接入 | Parser 每跳使用共享安全能力，无 context 同样受控 | MCP Adapter/Parser，不直接复用 Gateway 入站 Filter |
| F3 目的地政策 | 公网限制、内网例外、代理、降级、跨 asset 授权明确 | 产品/部署政策；禁止实现时静默选择新默认 |
| F3 请求层能力 | 异步每跳授权、DNS 全集分类、地址固定、peer/TLS/代理一致性 | 仅加 beforeRedirect 或观测计数不足 |
| F3/F4 证据 | 矩阵执行、拒绝前无连接/写出、泄漏扫描及 Windows/Linux 集成 | 后续授权验证；C2 Linux 文件权限为独立证据轨 |

D1 allowlist 与 F3 网络防护仍为提案，完成条件由本契约的矩阵与剩余依赖共同定义。C3/Gateway 的显式配置激活不替代这些退出条件。F3 全包还包含本文以外的生命周期审计、CLI/Process Info 防护和完整 Secret Scan。验证结果与任务状态以[执行台账第 18 节](E:/CodexDev/api-nova/docs/guides/security-development-execution-status.md)为准。

## 显式MCP单跳模式增量

标准Parser/Server进程内入口可选single-hop共享Resolver，必须带可信操作映射；每调用捕获一次Registry快照，按Endpoint ID及Source Asset/URL解析。剥离消费者及全部候选托管头，None无旧env/authManager回退；私有Axios实例隔离全局interceptor/认证默认值。新模式不允许自定义handler绕过。

该模式固定maxRedirects=0并返回3xx，故没有自动下一跳秘密/正文转发；未启用模式的legacy路径仍保留原跳转行为。本增量不提供DNS/SSRF、自动逐跳复验、任意宿主adapter防护或完整业务allowlist。生产托管链接入及DB归属仍未完成，详见[单跳接入契约](./mcp-trusted-operation-bindings.md)。
