---
doc-version: 1.0.0
doc-status: active
doc-updated: 2026-09-21
---
# D1/F3 请求头与网络边界契约

本文定义 D1 业务 Header allowlist 与 F3 redirect/DNS/SSRF 的兼容策略和验收边界。当前能力以实现引用为依据。2026-09-21 冻结 D1 Header 政策（第 3 节），作为 SEC-D1-02 的实施约束；政策定稿不代表代码已实现。F3 网络政策仍是独立提案，不因 D1 定稿改变默认网络策略。

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
- 三项均未配置时保持 legacy；只配置部分、值非法或加载失败时拒绝启动。当前支持 manual 和固定文件 watch；watch 使用 Registry 的 startWatchingFile，由统一重载路径验证后替换快照。此处不声称多进程同时生效。

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

## 3. D1 Header 政策 v1（已定稿，待实施）

本节是项目选择，不声称当前代码具备这些能力。范围为 Gateway 请求与响应；共享名称/值校验可供 Parser 复用，Parser 的实际生产接入和逐跳网络授权仍分别属于 E1/F3。不得用纯函数测试替代 Gateway 真正出站及返回客户端的证明。

### 3.1 配置、继承和激活

- 策略对象采用 `{ version: 1, requestHeaders?: string[], responseHeaders?: string[] }`，仅含名称，禁止 Header 值、通配符、正则和未知键；名称转小写后去重。扩展最多每方向 64 名。请求和响应分别继承，不能混为一张表。
- Registry 路径在 Site 上保存 `headerPolicy`，Endpoint override 可保存同名策略。Endpoint 某方向缺失表示继承 Site；显式空数组表示只有该方向基础集合；非空数组替换 Site 的同方向扩展。Site 某方向缺失即无扩展。只接受 version=1，不猜测未来版本。
- 未使用 Registry 的 Gateway 路由在现有 `upstreamConfig.headerPolicy` 保存完整 v1 策略，没有 Site 继承；基础集合相同。Registry 管理的路由同时提供内联 Header 策略应拒绝激活，避免两份来源的覆盖歧义。上述字段目前尚未加入执行 Schema。
- 编译产物固定策略版本、有效集合及来源标识，随对应路由/Registry 快照原子发布；编译失败保留旧有效快照，首次启动没有有效快照则拒绝该配置。不得只忽略非法字段后继续。
- 请求级固定有效策略；缓存键必须包含有效 Header 策略版本/内容标识，更新快照同时清空旧缓存。Registry 版本与路由版本不可隐式混搭。

### 3.2 请求字段决定

| 字段/类别 | v1 决定 | 约束 |
| --- | --- | --- |
| accept、accept-language、accept-encoding、content-type、content-encoding | 基础允许 | 正文字节不转换、不解压；压缩请求和响应须验证真实字节 |
| if-match、if-none-match、if-modified-since、if-unmodified-since、if-range、range | 基础允许 | 含任一字段的请求绕过缓存读取和写入 |
| cache-control、pragma | 基础允许 | 含任一字段的请求绕过缓存读取和写入，不自行解释后放宽 |
| idempotency-key、prefer、x-business、版本/租户/业务关联头 | 仅精确扩展允许 | 幂等键不授权重放；租户头不构成认证身份 |
| origin、referer、user-agent | 仅精确扩展允许 | 外部自述信息，不作为可信身份；CORS 不从本策略自动生成 |
| traceparent、tracestate、baggage | v1 禁止普通扩展并剥离 | 后续专门追踪策略再开放，不能把追踪内容默认送上游 |
| authorization、proxy-authorization、x-api-key、cookie、当前消费者鉴权配置指定的自定义 Header 名 | 始终剥离入站值，禁止业务扩展 | 消费者凭据 Passthrough 没有例外 |
| 所有当前候选托管认证名，以及已登记的历史认证名 | 始终剥离入站值，禁止业务扩展 | 不因 Endpoint None 或删除凭据而恢复；迁移清单须记录历史名，旧认证名不得改名为业务扩展规避 |
| connection、keep-alive、proxy-authenticate、te、trailer、trailers、transfer-encoding、upgrade | 逐跳剥离，禁止扩展 | 所有 Connection 值提名的字段同样剥离，即使它在基础清单内 |
| host、forwarded、x-forwarded-*、x-real-ip、x-request-id、x-apinova-* | 保留字段，禁止扩展 | 不接受客户端指定目标、身份、请求 ID 或内部状态 |
| content-length、expect | 由第 3.5 节传输规则处理 | 不是业务扩展；拒绝 framing 歧义 |
| 其余名称 | 默认剥离 | 只有合法精确扩展才能放行，不存在 allow-all 模式 |

未知历史认证名默认因未入 allowlist 被删除；无法从任意名称推断用途，不宣称已经识别所有秘密。扩展发布审阅必须确认该名称不是认证/会话令牌，不得自动从流量学习后放行。

### 3.3 响应字段决定

响应同样执行独立 allowlist，并先删除逐跳字段、所有响应 Connection 提名字段及保留字段。源响应的字段不会因请求扩展而获准。

| 字段/类别 | v1 决定 | 约束 |
| --- | --- | --- |
| content-type、content-encoding、content-language、content-disposition、etag、last-modified、cache-control、expires、vary、accept-ranges、content-range、location、retry-after、date、age | 基础允许 | 不跟随 Location；值校验不宣称已解决 F3 URL/SSRF |
| 自定义业务响应头、link、allow、CORS access-control-* | 仅精确扩展允许 | 不自动开放整组前缀，不自动改变控制面或 Gateway 自身 CORS 政策 |
| authorization、proxy-authorization、proxy-authenticate、x-api-key、cookie、set-cookie、www-authenticate、所有托管认证名 | 剥离并禁止扩展 | v1 不承载上游浏览器会话或上游认证挑战；需要这些能力的旧路由必须显式迁移，不静默放行 |
| server、x-powered-by、forwarded、x-forwarded-*、x-real-ip、x-request-id、x-apinova-*、traceparent、tracestate、baggage | 剥离并禁止扩展 | Gateway 只生成自己的请求 ID/缓存状态，不复用上游值 |
| content-length、transfer-encoding、trailer、trailers、upgrade 及其他逐跳字段 | 交由传输层处理或剥离 | 不原样复制上游分块/连接控制信息 |
| 其余字段 | 默认剥离 | 精确扩展不得覆盖上述禁止名 |

Set-Cookie 即使被输出过滤，原始上游出现它仍禁止存缓存；不得通过先删除字段把原来不安全的响应变成可缓存。响应扩展只能使用单值语义，v1 不提供 Cookie 列表例外。

### 3.4 名称、值和多值

1. 名称必须为合法 HTTP token。v1 应用层每方向原始字段最多 100 个，名称和值合计 UTF-8 字节不超过 16 KiB，单值不超过 8 KiB；运行时更严格的原生上限仍有效。非法名称、NUL、CR/LF 和其他不允许的控制字符拒绝，不截断后发送。水平制表符仅在字段值允许，首尾 OWS 归一化；不得对凭据秘密自行 trim 后改变含义。
2. 必须从原始字段列表识别重复（Gateway 入站/上游响应使用 rawHeaders）；只检查 Node 已合并的 headers 不足。大小写别名算同名。原始字段缺失的内部适配路径必须提供等效列表，不能默认为没有重复。
3. 允许按原出现顺序用逗号合并的请求字段仅为 accept、accept-language、accept-encoding、cache-control、pragma、if-match、if-none-match、prefer；响应仅为 cache-control、vary、accept-ranges、link、allow。字段仍须已获基础/扩展授权。
4. 其他获准字段都是单值；重复单值即拒绝，不以 first/last wins 或数组 join 掩盖。重复消费者认证字段/凭据字段和 content-length，即使值相同也拒绝。Connection 的多个值仅用于累计剥离集合，不向外复制。已经禁止且非认证/framing 字段可直接剥离，不因重复而重新放行。
5. 入站非法值/重复单值返回 400，超过应用层大小/数量上限返回 431；上游非法响应在客户端 Header 写出前返回固定 502。流开始后的长度/中断错误销毁连接并审计，不拼接第二个 JSON 错误。原因只包含安全代码和字段名，不包含值。

### 3.5 Framing、代理字段和凭据输出

- 同时出现 Content-Length 与 Transfer-Encoding、重复 Content-Length、非十进制非负安全整数长度，入站 400；上游等价歧义 502。原生 HTTP parser 若更早拒绝，仍须用真实 socket 用例证明没有出站发送；应用代码不能以解析器已经处理为由跳过内部适配路径验证。
- 入站 Transfer-Encoding 只接受单一 chunked，其他编码/列表拒绝；解分块后的实体流按字节转发，出站分块由 Node 生成，不复制客户端 Transfer-Encoding。声明了合法单一 Content-Length 且正文完全不变时可使用校验后的长度，并累计实际字节；不匹配立即中止，不补空正文、不自动重试。
- 未知长度流不伪造 Content-Length；由传输层选择 framing。空体、HEAD、204、304 的禁止正文/元数据长度语义须分别处理，不能一律设零。上游合法长度只能在无转换且状态允许时转出，并检查字节；缓存实体长度从实际缓存字节生成。禁止为了校验长度而无界缓冲。
- v1 不支持 Expect/100-continue 代理、Upgrade 或 trailers 业务传递：出现 Expect 在上游连接前返回 417，升级请求拒绝；必须验证服务器 checkContinue/checkExpectation 路径，不得先回 100 再进入拒绝逻辑。声明 trailers 的业务请求拒绝；未声明的末尾 trailers 不转发，并审计丢弃。响应逐跳升级/非最终响应不得作为普通成功响应转出；合法上游 trailers 丢弃。
- 保留现有取消传播并验收中途断开；仅已有明确许可的空体重试适用，不由 Header 政策扩展重放范围。
- v1 采用单一、不信任转发链的代理规则：X-Forwarded-For 只取当前 socket peer；X-Forwarded-Proto 只取实际入站 TLS 状态；X-Forwarded-Host 取已校验的唯一入站 Host（缺失/非法拒绝），不能影响目标 Host。剥离客户端 Forwarded/所有 X-Forwarded-* 和 X-Real-IP。v1 不开放 trusted-proxy 例外，未来独立版本再加入；这些字段不作为 Principal。
- Host 来自已解析的上游 URL。请求 ID 由 Gateway 新生成或复用本次入口已生成的内部 ID，不能复用未经验证的客户端值；响应返回同一 ID。
- 执行顺序固定为：原始字段/传输校验 → 认证/逐跳/保留字段剥离 → 业务 allowlist → framing 和代理元数据重建 → 校验并最后注入 Resolver 凭据。发送前可判定的校验失败不得连接上游；流中才能发现的长度/取消失败按本节立即中止。F3 加入后网络授权也必须在发送前完成。
- Resolver 输出仅允许认证用途的 Authorization、X-API-Key 或合法自定义认证名；不得占用基础业务名、已声明业务扩展、Cookie、Set-Cookie、Proxy-Authorization、Host、framing、逐跳、追踪、代理及内部保留名。名称/单值约束同样校验。冲突在激活时拒绝，动态输出再次防守并固定 503，禁止回退 Env 或消费者值。None 输出空凭据；可信凭据不因消费者的 Connection 提名而被取消。

### 3.6 缓存闭合规则

安全 v1 初版优先绕过未经证明的缓存语义，不为了命中率扩大 Header 放行：

- Range、任何 If-*、Cache-Control、Pragma 请求同时 bypass 读/写；只缓存无正文 GET，其他方法 bypass。
- Accept-Encoding、Accept、Accept-Language 和所有有效业务扩展的规范化值自动进入缓存键（允许名单中未出现的值也须区分缺失）。键内还包含有效策略标识及已有验证身份，不能由用户配置删除这些必需维度。不得把凭据值放入键或日志。
- 响应 Cache-Control 含 private/no-store/no-cache、Pragma、Vary=*、无法解析的缓存指令，或 Vary 提到未覆盖的请求字段时不存缓存。响应 206、SSE、原始 Set-Cookie、正文不完整/超捕获上限同样不存；现有 TTL 不替代这些拒绝条件。
- 缓存保存过滤后的业务响应头和原始实体字节；压缩实体不解压，命中时重建 framing/请求 ID，禁止重放逐跳/上游认证字段。需以真实 HTTP 的 miss/hit/不同编码及分段/条件请求验证。

### 3.7 迁移、禁用与例外

1. v1 是 D1-02 完成后所有新建 Gateway 路由的默认政策，缺省扩展为空；显式 version 非法一律失败。已有路由未配置时仅在迁移阶段维持 legacy，必须可列出数量和路由 ID；不能把 legacy 当作 v1 的宽松选项。
2. 迁移差异报告只记录字段名、方向、次数及配置引用，不记录值；列出 Cookie 会话、上游挑战、历史自定义认证名、代理链、Expect/trailers、缓存兼容差异。已观察到的字段不得自动入清单。
3. 每条 legacy 例外必须有路由 ID、责任人、原因、UTC expiresAt 和回退依据；v1 上线后最长 30 天，过期拒绝激活或运行（固定 503），不能自动续期。不允许以全局 env、关闭校验或通配符掩盖例外。legacy 也不新增消费者凭据 Passthrough。
4. v1 激活后不能通过删除 headerPolicy、null、未知版本、删除 Registry 或关闭 Provider 降级成 legacy。配置变更需要保留已迁移状态并拒绝这类降级；显式回滚只能回到先前验证通过的 v1 快照。尚未迁移的 legacy 快照验证失败可保留原快照，但例外截止时间仍执行。
5. D1-02 实施可保留有期限的迁移入口并验证上述行为；SEC-D1 父包闭合还要求交付默认配置无未处理 legacy 路由，以及任何实际部署例外清单/期限有证据。不得以测试夹具中全部 v1 推断生产迁移完成。

### 3.8 D1-02 可直接执行的实施边界

| 工作 | 已有基础 | D1-02 必须补齐 |
| --- | --- | --- |
| 编译与配置 | Registry 原子快照、Gateway upstream raw 配置 | v1 Schema、双方向继承/替换、两来源冲突、保留名和凭据输出校验、迁移状态防降级 |
| 请求 | 认证/Connection/候选名剥离与 Resolver 注入 | 真正 allowlist、rawHeaders 多值/限额、当前消费者自定义认证名剥离、历史名迁移、可信代理生成规则 |
| 响应 | 值转字符串/数组 | 独立 allowlist、逐跳/认证剥离、异常拒绝、缓存前保留禁止存储信号 |
| 传输与缓存 | PassThrough/取消传播、身份隔离、可配置 vary | §3.5、§3.6 的真实字节、framing、Expect、miss/hit 拒绝与隔离验证 |
| 迁移与证据 | 旧行为回归夹具 | 默认开启、legacy 有期限例外、不能删除配置降级、H01–H12 逐项报告 |

SEC-D1-01 的完成证据是本节定稿与逐项选择；不是 H01–H12 已全部通过。当前生产代码仍存在未知业务头透传、普通数组一律逗号合并、入站 XFF 前缀保留、响应无同等过滤等缺口。D1-02 不依赖 F3 DNS/redirect 实现才能推进，也不得把完成 Header 策略说成已完成 SSRF 防护。

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

本矩阵定义 30 项验收要求，不声明均已通过。H01–H12 按第 3 节冻结的 D1 v1 执行；N01–N17 保留 F3 提案状态；L01 跨两者验收。“已有用例”表示存在相应断言；“缺口”指所列代码路径未实现该防护。实际执行结果统一见[执行台账第 18 节](E:/CodexDev/api-nova/docs/guides/security-development-execution-status.md)。

离线夹具：Site A 为 https://a.example/api，属于 asset A；Endpoint P 使用 synthetic-a，Endpoint N 显式 None；Site B 为 https://b.example/api，使用 synthetic-b。URL 仅作内存输入；mock Resolver、DNS、HTTP(S) request、Agent/socket 和 Axios adapter，不访问真实 DNS/网络或真实 Env 秘密。记录 resolveCalls、lookupCalls、connectCalls、writeCalls、发送 Header、正文摘要及审计事件。使用可注入时钟和流桩模拟超时、取消、部分发送与跳转。

| ID | 输入/操作 | 必须断言 | 状态 |
| --- | --- | --- | --- |
| H01 | 大小写混合 Authorization/X-API-Key/Cookie/Proxy-Authorization | 消费者值不出站，有绑定时只出现当前合成凭据 | 已有用例；结果见执行台账 |
| H02 | Connection 字符串/数组/重复名/空项，声明业务和认证头 | 入站声明字段全剥离；可信凭据仍可注入；trailer/trailers 分别断言 | 现有逻辑，部分已有用例 |
| H03 | x-business 未在 allowlist | 当前基线保留，新策略启用后剥离；两种夹具分开 | 基线已有用例；政策已定，待实现 |
| H04 | Endpoint 扩展缺失/空/替换 Site | 分别继承/仅基础/基础加 Endpoint 扩展；拒绝通配符和非法名 | 政策已定，待实现 |
| H05 | allowlist 含凭据/逐跳/代理保留名 | 请求/响应策略与凭据输出冲突均拒绝激活；旧快照有效，无网络调用 | 政策已定，待实现 |
| H06 | None 且携带其他候选的认证名 | 候选托管名剥离，不注入凭据 | 已有用例；结果见执行台账 |
| H07 | 轮换后删除旧自定义认证名 | 新策略剥离未允许的旧名；基线显式暴露当前剥离清单局限 | 缺口/政策已定，待实现 |
| H08 | 大小写重复/重复单值/CR-LF/多值 Accept | 按 §3.4 原始字段规则拒绝或合并，无重复凭据和 framing 歧义 | 政策已定，待实现；当前统一逗号合并 |
| H09 | 伪造 XFF/Forwarded/request-id，v1 peer-only 与 legacy 迁移 | 当前 XFF 保留前缀作基线；v1 只用 socket peer 构造链，身份不采用伪造值 | 现状+政策已定，待实现 |
| H10 | 固定长度/分块/空体/Expect/取消 | framing 和实际字节一致，无双 framing、二次消费或空体重放 | §3.5 已定，待实现 |
| H11 | Range/If-*/Accept-Encoding 不同而路径相同，随后缓存命中 | 状态/Header/正文与直连语义一致；按 §3.6 强制隔离或 bypass 有证据 | 政策已定，待实现，依赖 D2 |
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
| D1 编译 Schema 与迁移实施 | 第 3 节已冻结来源、版本、继承/替换、非法拒绝、兼容差异和有限例外 | SEC-D1-01 政策完成；SEC-D1-02 实施与真实传输验收仍待完成 |
| D2 缓存与传输 | 条件/范围/压缩头、framing、可信代理和重放规则闭合 | Gateway 数据面集成 |
| E1 MCP 接入 | Parser 每跳使用共享安全能力，无 context 同样受控 | MCP Adapter/Parser，不直接复用 Gateway 入站 Filter |
| F3 目的地政策 | 公网限制、内网例外、代理、降级、跨 asset 授权明确 | 产品/部署政策；禁止实现时静默选择新默认 |
| F3 请求层能力 | 异步每跳授权、DNS 全集分类、地址固定、peer/TLS/代理一致性 | 仅加 beforeRedirect 或观测计数不足 |
| F3/F4 证据 | 矩阵执行、拒绝前无连接/写出、泄漏扫描及 Windows/Linux 集成 | 后续授权验证；C2 Linux 文件权限为独立证据轨 |

D1 allowlist 政策已经定稿，执行代码与 H01–H12 验收尚待完成；F3 网络防护仍为提案。两者完成条件分别由本契约对应矩阵与依赖定义。C3/Gateway 的显式配置激活不替代这些退出条件。F3 全包还包含本文以外的生命周期审计、CLI/Process Info 防护和完整 Secret Scan。验证结果与任务状态以[执行台账第 18 节](E:/CodexDev/api-nova/docs/guides/security-development-execution-status.md)为准。

## 显式MCP单跳模式增量

标准Parser/Server进程内入口可选single-hop共享Resolver，必须带可信操作映射；每调用捕获一次Registry快照，按Endpoint ID及Source Asset/URL解析。剥离消费者及全部候选托管头，None无旧env/authManager回退；私有Axios实例隔离全局interceptor/认证默认值。新模式不允许自定义handler绕过。

该模式固定maxRedirects=0并返回3xx，故没有自动下一跳秘密/正文转发；未启用模式的legacy路径仍保留原跳转行为。本增量不提供DNS/SSRF、自动逐跳复验、任意宿主adapter防护或完整业务allowlist。生产托管链接入及DB归属仍未完成，详见[单跳接入契约](./mcp-trusted-operation-bindings.md)。
