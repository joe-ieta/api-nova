---
doc-version: 1.43.0
doc-status: active
doc-updated: 2026-09-24
---
# D1/F3 请求头与网络边界契约

本文定义 D1 业务 Header allowlist 与 F3 redirect/DNS/SSRF 的兼容策略和验收边界。当前能力以实现引用为依据。2026-09-21 冻结 D1 Header 政策（第 3 节），作为 SEC-D1-02 的实施约束；政策定稿不代表代码已实现。F3 网络政策在第 4 节定稿；两项政策均须经实现与迁移验收才改变现有运行默认。

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

### 2.1 Gateway Header（当前生产legacy路径）

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

## 3. D1 Header 政策 v1（已定稿，分阶段实施）

本节是项目选择；02A编译、02B显式策略执行和02C缓存已交付。原02D已拆为D1 Registry执行接线、D2迁移防降级、D3实际入口和D4联合验收；生产启用仍须全部闭合，不能声称能力已上线。范围为 Gateway 请求与响应；共享名称/值校验可供 Parser 复用，Parser 的实际生产接入和逐跳网络授权仍分别属于 E1/F3。不得用纯函数测试替代 Gateway 真正出站及返回客户端的证明。

### 3.1 配置、继承和激活

- 策略对象采用 `{ version: 1, requestHeaders?: string[], responseHeaders?: string[] }`，仅含名称，禁止 Header 值、通配符、正则和未知键；名称转小写后去重。扩展最多每方向 64 名。请求和响应分别继承，不能混为一张表。
- Registry 路径在 Site 上保存 `headerPolicy`，Endpoint override 可保存同名策略。Endpoint 某方向缺失表示继承 Site；显式空数组表示只有该方向基础集合；非空数组替换 Site 的同方向扩展。Site 某方向缺失即无扩展。只接受 version=1，不猜测未来版本。
- 未使用 Registry 的 Gateway 路由在现有 `upstreamConfig.headerPolicy` 保存完整 v1 策略，没有 Site 继承；基础集合相同。Registry 管理的路由同时提供内联 Header 策略应拒绝激活，避免两份来源的覆盖歧义。上述字段现已加入Parser编译Schema和不可变候选快照（D1-02A）；Gateway在02B/C执行器就绪前明确拒绝该策略保存/激活，不表示已有过滤能力。
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

## 4. F3 每跳网络与凭据政策 v1（已定稿，待实施）

本节冻结 SEC-F3-01 的允许/拒绝合同，供 SEC-F3-02A–D 实施，不声明现有数据面已经执行。网络授权属于实际请求层，不放入无网络 I/O 的纯 Resolver；网络政策与凭据政策都通过才可发送。None、Anonymous、无观测 context 和无凭据的请求同样受控。禁止通过仅设置 `maxRedirects=0` 宣称完成 SSRF 防护，初始请求仍必须满足 DNS、连接与目的地授权。

### 4.1 配置范围、默认与迁移

1. 网络策略采用 `version: 1`，绑定 source asset 与 Site 的精确 origin（scheme、规范化 host、有效 port），保留 Site/base path 和 Endpoint 授权。只支持 `public` 或 `private-exception` 两种目的地模式及 `direct` 连接模式。禁止通配 origin、正则、allow-all、任意代理、自定义传输器绕过和未知配置字段；Endpoint 只能收窄目的地，不能扩大 Site 权限。
2. F3 执行器交付后，新建或重新发布的配置缺省为 `public + direct`。已有内网业务必须先登记第 4.2 节的例外再迁移，不将过去可达视为授权。本文定稿不修改任何当前部署、环境变量或运行配置；执行器就绪前显式 v1 激活必须拒绝，不能保存成看似受控却未执行的配置。
3. 已有 legacy 仅在迁移清单内保留，逐项记录 runtime/route/source asset、责任人、原因、UTC 到期时间和回退依据，F3 上线后最长 30 天。到期或条目缺失拒绝激活/请求，不自动延期。legacy 状态必须显式可见，不能计入 F3 防护通过；一旦迁移 v1，不允许通过删策略、null、关闭 Provider 或环境变量退回 legacy，只能回滚到有效且未到期的 v1 快照。
4. 网络政策编译产物包含 policy ID、revision、分类表版本、有效例外及内容标识，随不可变快照发布。非法配置保留旧有效快照，首次没有有效快照则失败关闭；旧快照仍执行其到期与撤销条件。跨进程同步不能由单进程 reload 用例代替。
5. 仅 HTTP/HTTPS，拒绝 userinfo、fragment、控制字符、尾点主机、模糊端口及现有 Resolver 禁止的编码路径；国际化域名先规范化为同一 ASCII host 再精确匹配。首次 HTTP 仅在明确配置 HTTP Site 时允许，HTTPS 跳转到 HTTP 始终拒绝，v1 无降级例外。HTTP 本身不提供保密性，网络授权不能宣称传输加密。

### 4.2 地址分类与内网例外

| 目的地 | public | private-exception |
| --- | --- | --- |
| 可公网单播地址，且不属于拒绝范围 | 仍须通过 Site/origin/Endpoint 授权 | 仅在本例外精确地址清单内允许；不与 public 自动取并集 |
| RFC1918 私网、IPv6 ULA、loopback | 拒绝 | 仅允许已登记的精确 origin、端口及地址/CIDR 交集；loopback 必须是单地址 /32 或 /128 |
| unspecified、link-local、共享地址、组播、广播、文档/基准测试/其他保留及非公网可路由地址 | 拒绝 | 拒绝，不能通过例外放行 |
| 部署登记的元数据服务、控制面/管理接口地址与端口 | 拒绝 | 始终拒绝，优先级高于允许清单 |
| IPv4-mapped IPv6 | 先提取并按内嵌 IPv4 判断 | 同左，同时保留连接 peer 的规范化等价比较 |
| zone ID、IPv6 转换/隧道表示、非标准 IPv4 整数/八进制/十六进制/缩写 | 拒绝 | 拒绝；必须在 URL 解析器自动改写前识别，不允许变成普通域名逃逸 |

地址判断使用有版本的完整分类表或明确锁定版本的分类组件；上表定义拒绝类别，不允许实现仅检查 `127.`/`192.168.`。新增未知类别按拒绝处理。SEC-F3-02A 必须交付分类来源、版本和 IPv4/IPv6 边界用例；不能依赖 DNS 回答者宣称目标“公网”。

内网例外是部署受信任配置，用户请求、OpenAPI 文件、Location 或工具参数不得创建例外。每项必须包含 exception ID、source asset ID、Site ID、精确 origin、非空规范化地址/CIDR 清单、用途、责任人、审批记录引用、issuedAt、UTC expiresAt；有效期最长 30 天，延期必须产生新的审阅记录和 revision。禁止 `/0`、跨允许地址类别的宽网段、自动从一次解析结果学习地址。例外与凭据授权相互独立，不自动授予 Endpoint、秘密或跨资产权限。到期即时拒绝新发送，即使长连接或快照尚未刷新。

部署控制面/元数据拒绝清单不得来自消费者输入，并在启动时固定并校验；无法确定隔离边界的本机服务不能仅凭 loopback 例外上线。测试允许受控 loopback fixture，但必须标记测试配置，不能成为生产默认值或验收全部内网已安全的依据。

### 4.3 每次发送前的状态机、连接与代理

适用于初始请求、获准 redirect 下一跳、retry 的每次新连接；任何步骤失败均不回退旧凭据、Env、消费者值或不受控 adapter。

1. 捕获逻辑操作的网络/凭据快照和撤销世代，规范化 URL，以原 source asset 和目标的真实 method/path 重新选择 Site/Endpoint。Location 相对当前 URL 解析；同源跳出 base path、进入更具体 Site、变更端口也必须复验。不得沿用初始 Endpoint ID 给下一跳授权。
2. 解析目标 A/AAAA 最终结果全集，包括 CNAME 最终地址；域名与直接 IP 同一分类规则。任一返回地址禁止即整次拒绝，不只挑一个公网地址。空答案、非法结果、解析超时、无法取得完整受控解析结果均失败关闭。DNS 单次上限 5 秒且受本次请求剩余总时限约束，不能因多跳重新扩充超时。
3. 将允许的具体 IP 固定到本次 socket 连接，保留逻辑 Host、TLS SNI 和证书 hostname 验证；禁止校验后让传输库再次无约束解析。v1 不跨逻辑操作复用出站 socket，不接受外部提供的 socket/Agent；每次新连接与重试重新解析和授权。IPv4/IPv6 备选尝试也仅能使用本次已批准集合。
4. HTTP 在连接建立后、HTTPS 在握手及证书校验成功后，检查实际 `remoteAddress` 与批准 IP 相符，再允许任何 HTTP Header/正文写出。TLS 禁止 `rejectUnauthorized=false`、跳过 hostname 校验和静默降级。无法阻止提前写出的 Agent/adapter 不可用于 v1；事后发现 peer 错误并销毁连接不能作为零泄漏证据。
5. 使用当前目标的可信业务模板按 D1 重建 Header，删除所有上一跳托管认证名和消费者凭据；网络与 Resolver 授权均成功后最后注入目标凭据。目的地与正文授权先于正文写出。失败不可把旧秘密带到新目标，也不可复用上一跳的认证输出作为模板。
6. 发送前复核期限、取消、撤销世代及例外有效期；流中取消立即销毁上下游。审计按同一逻辑操作 ID 关联真实 hop/attempt，拒绝时记录阶段和安全原因，不伪造已发送节点。

v1 只支持直连。显式配置代理或自定义 Axios adapter/transport 一律拒绝激活；隔离的传输客户端必须显式禁用 `HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY` 及小写别名、`NO_PROXY` 自动代理选择，不修改宿主环境变量。迁移报告列出受影响的旧代理依赖并要求整改后激活，不能静默经代理发送，也不能让 NO_PROXY 决定安全授权。本机 DNS 校验不能证明代理最终目标；受控代理、CONNECT 与代理端 DNS 授权留待单独政策版本，不以其缺席阻塞 v1 的明确拒绝验收。

### 4.4 Redirect、正文与跨目标凭据

| 场景 | v1 决定 |
| --- | --- |
| Gateway / 显式 MCP single-hop | 保持不跟随；合法 3xx 状态和经 Header 政策验证的 Location 返回调用方，hop=0；Location 不代表 ApiNova 已授权客户端访问目标 |
| Parser 允许自动跟随的迁移路径 | 显式启用 `safe-read`，最多 5 次跟随（初始 hop=0，后续 1–5），第 6 次拒绝；默认不跟随，不沿用 Axios 隐式跳转器绕过状态机 |
| 301/302/303/307/308 的无正文 GET/HEAD | 仅 safe-read、目标全授权且不循环时跟随；保持 GET/HEAD，不自动改变方法 |
| 任何带正文请求、POST/PUT/PATCH/DELETE/其他方法 | v1 不自动跟随；返回单跳 3xx，不把 POST 改 GET，也不重放缓存正文/不可重放流；调用方重新调用需重新授权 |
| 非法/缺失 Location、超跳数、规范化目标循环 | 要求跟随的场景拒绝下一跳；不得连接/写出。未启用跟随时不解析为新的出站目标 |
| 同 asset 跨 origin | 仅网络政策与目标 Site/Endpoint 都明确授权才允许；重建目标凭据，禁止带前一 Site 的 Authorization、API Key、自定义认证头或 Cookie |
| 跨 asset | v1 拒绝；不从 hostname 推断新资产，不继承原资产权限 |
| 同 origin 的 None Endpoint | 可按网络政策访问，但不携带前一 Endpoint 凭据；Endpoint 不明或选择歧义拒绝 |
| HTTPS → HTTP | 始终拒绝跟随；不得以目标存在 HTTP Site 放行 |

自动跳转的 `safe-read` 是能力收窄，不把合法 3xx 当业务重试。总时限继承入口已生效的请求超时，不能每跳重新计时；剩余时间不足、取消或一次已发送且无法确认完成时不得隐式重试。F3 不增加业务重试资格，既有明确允许的空体重试仍须执行第 4.3 节。

### 4.5 快照、撤销、缓存与拒绝语义

- 普通 reload 只影响新逻辑操作，当前操作固定同一网络/凭据 revision；不在链中混用新 Site 与旧凭据。现有 Gateway adapter 只返回 Header 和名称，尚不具备整链句柄，这一接口缺口属于 F3-02，不能以一次 resolve 代替证明。
- 凭据/例外/目的地显式撤销或安全收窄必须递增受信任撤销世代。每次发送前发现世代改变即终止当前操作，不在旧链中自动重新选新凭据继续；有在途连接时主动取消，已发出的字节不可撤回。无法读取有效撤销状态则失败关闭。一般轮换可按其已批准重叠期使用固定快照，但吊销与到期不得被重叠期绕过。多进程即时性必须有传播/确认接口和真实证据，未接入的进程不能标为完成。
- 缓存命中也须复核当前调用权限、网络策略有效性、例外期限及撤销世代；无需为不出站的命中建立 socket，但网络政策内容标识必须参与缓存隔离，安全收窄使旧缓存不可读。未提供这一证据的网络 v1 路由关闭缓存，不能复用 legacy 缓存宣称安全。
- 配置非法/未知版本在激活时拒绝；运行时目标/地址/跳转/撤销拒绝统一安全原因 `upstream_network_policy_denied`，Gateway 固定 502，MCP 使用等价工具错误；有效配置或撤销状态不可用为 `upstream_network_policy_unavailable`（Gateway 503）。总请求超时沿用超时响应，取消不补发错误正文。已开始回传的流故障销毁连接，禁止再拼接 JSON。
- 对外错误不暴露内网拓扑、解析 IP、原始 Location、查询参数、URL userinfo 或凭据。审计只记录操作 ID、asset/Site/Endpoint ID、policy/revision/撤销世代、hop/attempt、拒绝阶段与安全原因；目标只使用策略内的引用或脱敏标识，不存原始 URL/Headers/正文。无 context 时安全结论不变；观测失败不能绕过任何拒绝。

### 4.6 实施与验收出口

SEC-F3-01 到本节政策定稿完成；实施拆为F3-02A严格配置/地址分类、F3-02B1受控DNS全集授权、F3-02B2固定IP单跳直连/peer复核primitive、F3-02B3a Parser共享verified connection/Readable矩阵、B3b Parser host版本桥、B3c Gateway route Provider/stream桥、F3-02C逐跳凭据/redirect/撤销状态机和F3-02D N01–N17双运行时验收。A/B1/B2原语不能替代B3a–D；八项合并才覆盖受信任配置/例外、DNS全集与IP固定、HTTP/TLS写出前peer复核、直连隔离、逐跳凭据重建、快照/撤销及拒绝审计。不能以纯函数、设置零跳转、一次DNS检查或仅beforeRedirect hook关闭F3。

实现快照（2026-09-24）：F3-02A、B1、B2及B3a/b/c均按限定出口完成。C1a共享host-owned opaque authority与C5a纯network-failure/audit模块限定完成。C1b Parser接线以Parser 38 suites/925 tests、最终C1a+C1b定向2 suites/42 tests、typecheck/build及diff-check限定完成；C1c Gateway接线以4源码文件、Gateway 43 suites/649 tests、真实HTTP/TLS专项62/62、API build及diff-check限定完成；两侧在Resolver/body/cache前固定同一opaque handle、Snapshot、凭据、epoch及总deadline/abort，cache-off/单attempt保持，生产默认仍关闭。C1d现拆为D1 host安全epoch/提交事件合同、D2 Gateway Registry/Route/Provider桥、D3 Parser host lifecycle桥与D4本地联合验收；D1 READY，其余等待，多进程传播另验。C2拆为精确method+path目标目录C2a和多跳状态机/真实HTTP/TLS接线C2b；C2a IN_PROGRESS，C2b WAIT，未知、歧义、跨asset和scheme降级失败关闭。C4已READY；真实Provider撤销事件桥、原子revision、生产默认启用、缓存恢复/自动retry及F3D N01–N17环境矩阵继续等待，父TP-F3保持IN_PROGRESS。

SEC-F3-02D按第 5 节 N01–N17 冻结矩阵执行：N02 分别验证 legacy 基线和 safe-read 的 5 次边界；N13 验证例外精确匹配、到期和始终拒绝集合；N14 验证代理配置拒绝及各大小写环境变量均不触发代理连接；N15 验证所有非空体/非 GET、HEAD 不跟随且无第二次写出；N16 验证普通 reload 固定版本、撤销中断及每次新连接重新授权。矩阵同步为“政策已定，待实现”，不能用DOC状态替代真实执行证据。

真实验收必须使用受控 DNS、HTTP/HTTPS socket 和代理陷阱覆盖有/无 context、CNAME/A/AAAA 混合、重绑定、peer 不符、证书失败、取消、重定向和秘密泄漏。URL/策略/DNS 拒绝要求零目标连接；peer/TLS 拒绝可建连但零 HTTP Header/正文写出。内网测试例外不得转为生产默认。Windows/Linux 两个平台结果分别记录，缺失平台证据保留待验，不用本机模拟代替。完整 F3 父包还需要第 4 节之外的生命周期审计和 Secret Scan，网络政策完成不关闭这些剩余项。


## 5. 可执行验收矩阵

本矩阵定义 30 项验收要求，不声明均已通过。H01–H12 按第 3 节冻结的 D1 v1 执行；N01–N17 按第 4 节冻结的网络 v1 执行；L01 跨两者验收。“已有用例”表示存在相应断言；“缺口”指所列代码路径未实现该防护。实际执行结果统一见[执行台账第 18 节](E:/CodexDev/api-nova/docs/guides/security-development-execution-status.md)。

离线夹具：Site A 为 https://a.example/api，属于 asset A；Endpoint P 使用 synthetic-a，Endpoint N 显式 None；Site B 为 https://b.example/api，使用 synthetic-b。URL 仅作内存输入；mock Resolver、DNS、HTTP(S) request、Agent/socket 和 Axios adapter，不访问真实 DNS/网络或真实 Env 秘密。记录 resolveCalls、lookupCalls、connectCalls、writeCalls、发送 Header、正文摘要及审计事件。使用可注入时钟和流桩模拟超时、取消、部分发送与跳转。

| ID | 输入/操作 | 必须断言 | 状态 |
| --- | --- | --- | --- |
| H01 | 大小写混合 Authorization/X-API-Key/Cookie/Proxy-Authorization | 消费者值不出站，有绑定时只出现当前合成凭据 | 02B真实HTTP通过；生产仍门禁 |
| H02 | Connection 字符串/数组/重复名/空项，声明业务和认证头 | 入站声明字段全剥离；可信凭据仍可注入；trailer/trailers 分别断言 | 02B纯函数与真实Connection提名通过 |
| H03 | x-business 未在 allowlist | 当前基线保留，新策略启用后剥离；两种夹具分开 | 02B显式v1真实过滤通过；legacy基线保留 |
| H04 | Endpoint 扩展缺失/空/替换 Site | 分别继承/仅基础/基础加 Endpoint 扩展；拒绝通配符和非法名 | 02A编译/Registry通过；D1生产执行接线、D4联合验收待完成 |
| H05 | allowlist 含凭据/逐跳/代理保留名 | 请求/响应策略与凭据输出冲突均拒绝激活；旧快照有效，无网络调用 | 02A编译保旧与02B输出拒绝通过；生产仍拒绝激活 |
| H06 | None 且携带其他候选的认证名 | 候选托管名剥离，不注入凭据 | 02B None真实HTTP通过 |
| H07 | 轮换后删除旧自定义认证名 | 新策略剥离未允许的旧名；冷启动须从受信Parser Host历史Store与Gateway双库Ledger恢复单调历史 | D4C盘点acceptanceComplete:false；D4D1/D2/D3/D4 DONE，双Node/HTTP SQLite与隔离PG H07全true并清理；H07跨启动历史闭合，H11 membership→v1仍未闭合 |
| H08 | 大小写重复/重复单值/CR-LF/多值 Accept | 按 §3.4 原始字段规则拒绝或合并，无重复凭据和 framing 歧义 | 02B纯函数与真实重复/framing通过 |
| H09 | 伪造 XFF/Forwarded/request-id，v1 peer-only 与 legacy 迁移 | 当前 XFF 保留前缀作基线；v1 只用 socket peer 构造链，身份不采用伪造值 | 02B真实HTTP peer字段通过；完整迁移待D2/D4 |
| H10 | 固定长度/分块/空体/Expect/取消 | framing 和实际字节一致，无双 framing、二次消费或空体重放 | 02B真实流与独立Expect入口通过；生产入口安装待D3/D4 |
| H11 | Range/If-*/Accept-Encoding 不同而路径相同，随后缓存命中 | 状态/Header/正文与直连语义一致；按 §3.6 强制隔离或 bypass 有证据 | H11A完成Registry-source route-specific membership v1激活；H11B以真实deploy→plan/replay→activate→Nest HTTP/cache 33场景闭合，覆盖Range/If-*、gzip/identity字节、cache分区与直连/bypass；相关73 suites/1023 tests及API build通过 |
| H12 | Resolver 错误/None/旧 Env/非法 Env | Resolver 错误固定 503 且 connectCalls=0；旧 Env 分支独立断言，不错误套用固定 503 | 02B真实Resolver503零命中及旧专项通过；完整生产接线待D1/D4 |
| N01 | Gateway 收到 302/307 与 Location | 仅一次 request，返回状态/Location，hop=0，无下一跳 | 代码基线待执行 |
| N02 | Parser legacy与safe-read第五/第六次跳转 | 分别验证既有legacy基线和显式safe-read的5次边界；默认不跟随；有无context一致 | 政策已定，待实现 |
| N03 | 初始 scheme/host/port/base path/asset 不匹配 | C4 联网前拒绝，allowedHosts 不能单独放行 | Resolver 逻辑待执行 |
| N04 | 相对 Location 到同 Site 有效 Endpoint | 每跳复验、重建 Header，仅目标凭据出站，hop 递增 | 政策已定，待实现 |
| N05 | 同源跳出 /api、到 /api-evil 或 None Endpoint | 越界拒绝；有授权的 None 不携带前跳凭据；不复用初始 endpoint ID | 政策已定，待实现 |
| N06 | 同asset的Site A到B、端口变化及跨asset目标 | 同asset全授权时仅B凭据出站；无授权或跨asset拒绝下一跳连接/写出 | 政策已定，待实现 |
| N07 | HTTPS 降级/userinfo/非法 scheme/循环/超跳数 | 按显式政策拒绝，无下一跳写出；错误无敏感 URL | 首跳部分已校验，逐跳缺口 |
| N08 | DNS 返回 10.0.0.1、127.0.0.1、169.254.169.254、0.0.0.0、100.64.0.1 | 公网配置逐地址拒绝，connectCalls=0 | 政策已定，待实现 |
| N09 | ::、::1、fc00::1、fe80::1、::ffff:127.0.0.1、组播、zone ID | 公网配置拒绝；规范化变体不绕过 | 政策已定，待实现 |
| N10 | 2130706433、0x7f000001、127.1等URL | 准入拒绝非规范IP字面量，规范化变体不能绕过始终拒绝集合 | 政策已定，待实现 |
| N11 | A/AAAA 混合允许与禁止地址，CNAME 最终私网 | 整次拒绝，无连接；不只检查第一地址 | 政策已定，待实现 |
| N12 | DNS 先允许后私网、peer 不同、复用旧 socket | 连接绑定验证地址；peer 不符 writeCalls=0；复用不绕过授权 | 政策已定，待实现 |
| N13 | 精确内网origin/IP/端口例外、到期及始终拒绝地址 | 仅限期精确例外成功；过期/相邻地址/始终拒绝集合失败；legacy须显式迁移 | 政策已定，待实现 |
| N14 | 显式代理、自定义transport及各大小写代理环境变量/NO_PROXY | v1配置拒绝代理/自定义transport；直连客户端不继承环境代理；代理陷阱零连接 | 政策已定，待实现 |
| N15 | 307/308不可重放流；301/302/303 POST及空体GET/HEAD | 非空体或非GET/HEAD不跟随；仅safe-read可保持方法跟随空体GET/HEAD；无隐式重放 | 政策已定，待实现 |
| N16 | 两跳间普通reload/撤销，retry/DNS超时/取消 | 普通reload固定版本，撤销世代变化终止；每新连接重验，取消后无写出 | 政策已定，待实现 |
| N17 | 每种场景有/无context | 安全结果一致，观测失败不放宽政策，被拒跳不伪造发送 | 政策已定，待实现 |
| L01 | 全矩阵使用合成消费者/A/B 秘密，收集日志/异常/审计/快照 | 消费者秘密不出站，A 秘密不进入 B，采集输出无合成秘密，含安全原因/版本 | 待执行，不替代全量 F3 Scan |

网络拒绝分阶段断言：URL/策略/DNS 拒绝要求 connectCalls=0；peer 复核拒绝允许已建连但要求 writeCalls=0。不能用“最后 HTTP 报错”代替联网前或写出前证据。若 mock Agent 无法观测真实发送时点，该项仍未覆盖，不得用 mock 返回值宣布通过。

本地集成验收使用受控 HTTP/HTTPS/代理服务器验证 TLS、真实 socket、缓存、重放与平台差异，无需访问生产秘密或公网服务。

## 6. 依赖与退出条件

| 依赖 | 阻塞退出条件 | 责任边界 |
| --- | --- | --- |
| C3 稳定读取和显式配置激活（已实现） | 以 reloadFile 和启动工厂作为接入基线，不作为缺失能力阻塞 D1/F3 | 实现与操作见稳定文件读取、Gateway 凭据 Provider 和运行手册；验证见[执行台账第 18 节](E:/CodexDev/api-nova/docs/guides/security-development-execution-status.md) |
| C4 适配/配置校验 | 托管名、保留字段冲突、目标 Endpoint 身份、整链版本和撤销语义 | 共享 Resolver/适配接口；纯 Resolver 保持无网络 I/O |
| D1 编译 Schema 与迁移实施 | 第 3 节已冻结来源、版本、继承/替换、非法拒绝、兼容差异和有限例外 | H11A已限定完成Registry-source可信membership+持久v1 marker+trusted compiled/validated route的受控激活，复用G3同事务writer并在afterCommit切换snapshot；inline/legacy/unmigrated/unknown/unsafe仍fail-closed并保旧，F1 Verified未接线。H11B已以真实部署/激活/Nest HTTP/cache 33场景完成生产H01–H12验收；TP-D1按原退出条件DONE |
| D2 缓存与传输 | 条件/范围/压缩头、framing、可信代理和重放规则闭合 | Gateway 数据面集成 |
| E1 MCP 接入 | Parser 每跳使用共享安全能力，无 context 同样受控 | MCP Adapter/Parser，不直接复用 Gateway 入站 Filter |
| F3 目的地政策 | 公网限制、内网例外、代理、降级、跨 asset 授权明确 | 第4节政策已冻结；旧配置显式迁移，禁止静默改变默认 |
| F3 请求层能力 | 异步每跳授权、DNS 全集分类、地址固定、peer/TLS/代理一致性 | 仅加 beforeRedirect 或观测计数不足 |
| F3/F4 证据 | 矩阵执行、拒绝前无连接/写出、泄漏扫描及 Windows/Linux 集成 | 后续授权验证；C2 Linux 文件权限为独立证据轨 |

D1 allowlist 政策已经定稿，执行代码与 H01–H12 验收尚待完成；F3 网络政策已定稿，DNS及有界Buffer连接原语已限定实现；host/stream接线、逐跳执行与完整验收仍待完成。两者完成条件分别由本契约对应矩阵与依赖定义。C3/Gateway 的显式配置激活不替代这些退出条件。F3 全包还包含本文以外的生命周期审计、CLI/Process Info 防护和完整 Secret Scan。验证结果与任务状态以[执行台账第 18 节](E:/CodexDev/api-nova/docs/guides/security-development-execution-status.md)为准。

## 显式MCP单跳模式增量

标准Parser/Server进程内入口可选single-hop共享Resolver，必须带可信操作映射；每调用捕获一次Registry快照，按Endpoint ID及Source Asset/URL解析。剥离消费者及全部候选托管头，None无旧env/authManager回退；私有Axios实例隔离全局interceptor/认证默认值。新模式不允许自定义handler绕过。

该模式固定maxRedirects=0并返回3xx，故没有自动下一跳秘密/正文转发；未启用模式的legacy路径仍保留原跳转行为。本增量不提供DNS/SSRF、自动逐跳复验、任意宿主adapter防护或完整业务allowlist。生产托管链接入及DB归属仍未完成，详见[单跳接入契约](./mcp-trusted-operation-bindings.md)。

## D1-02A编译准备（2026-09-21）

[编译与安全接线证据](../audits/2026-09-21-header-policy-compilation.md)已交付schema/继承/identity和候选保旧；产品激活有未就绪门禁。双向传输、缓存和迁移依次归02B/C/D，不能删除门禁后即宣称全包完成。

## D1-02B受控执行（2026-09-21）

[双向真实流证据](../audits/2026-09-21-header-wire-execution.md)交付显式compiled路径的rawHeaders校验、双向过滤、framing与真实字节流；入口helper已验Expect但未挂生产main。v1运行路径暂时全部绕过缓存且出站不复用连接，旧路径不因此改为allowlist。

请求尚未完整发送而上游提前给最终响应时，v1保守502中止；此兼容差异归02D迁移评估。原生HTTP解析器隐藏的超长尾部不能由应用计数器全面识别，不能据此宣称请求走私全部解决。未就绪门禁保持到已完成的02C缓存及D1执行接线、D2默认迁移/防降级、D3入口、D4联合验收全部闭合。

## D1-02C缓存实施（2026-09-22）

[真实缓存证据](../audits/2026-09-22-header-cache-isolation.md)完成§3.6：命中前当前凭据/原始Header预检、必需vary/策略/可信身份及非敏感材料代次隔离、原始响应veto、压缩实体原样与命中framing重建。此增量替代上一02B阶段“v1暂时全部绕过缓存”的临时措施。

v1还保留完整query顺序并去掉消费者认证query；不允许配置裁剪必需维度。未知或无法解析缓存指令保守禁存；max-age/s-maxage及原始Age收窄TTL。生产Registry元数据/执行接线归D1，迁移归D2，入口归D3，重启与联合验收归D4；原始策略门禁未删除。
## D1-02D有界拆分（2026-09-24）

原02D不是单一验收动作，现以四个叶子执行：D1将同一Registry快照的Site/Endpoint策略、凭据、代次与历史名随不可变Prepared Exchange接入双向过滤/缓存；D2负责新路由默认v1、具名legacy最长30天、迁移状态持久和防删除/关Provider降级；D3在Nest/Socket.IO初始化后、listen前安装checkContinue/checkExpectation/upgrade；D4执行真实membership激活、数据库重开、冷启动迁移及H01–H12联合矩阵。D1以5套118项限定完成，D3以2套24项及API构建完成实际入口安装；D2进一步拆为A–D：A以3套57项完成具名legacy期限、未知字段与来源变更拒绝的纯迁移契约/校验器，且未接生产创建入口或持久化；B负责新Binding v1持久创建，C负责legacy最长30天与撤销，D负责冷重启/坏迁移/Provider拒绝降级验收。B以6套65项完成两新建入口v1草稿/来源持久写入、旧路由不回填与NOT_READY先行；C以3套45项完成显式例外登记/校验/撤销与持久墓碑；D以SQLite与隔离PG联合迁移/冷启动/CAS/撤销/重开4套49项及API构建完成。D4拆为A/B/C：A纯guard与局部真实HTTP 37项完成；B已完成生产运行时期限/撤销守卫接线，未获有效例外的旧Gateway路由按明确授权返回503，cache/Resolver/upstream零绕过；C以14套223项及隔离PG完成H01–H12限定矩阵盘点，但acceptanceComplete:false，H07冷启动与membership正式正向未闭环。D4D1以3 Parser files、12新增测试、29套557项及build完成Host Store/Registry CAS；D4D2以Entity/service、SQLite/PG迁移、CAS并集/上限/旧库重开及隔离PG zero-drift完成，但不接Provider；D4D3完成Provider/ledger/Registry bridge；D4D4以真实SQL.js并发CAS/watch stop/迁移回滚、双Node/HTTP SQLite与隔离PG完成H07跨启动历史验收；H11A/H11B现均登记为DONE；H11A以16项真实联合用例、strict helper 10项、Gateway+Publication 58 suites/778 tests及API build限定完成Registry-source route-specific激活；全API首轮唯一process-manager.temporary-anonymous超时，单跑4/4在12.09s通过且未改测试。F1 Verified未接线，inline/legacy/unmigrated/unknown/unsafe仍NOT_READY并保旧，无外部部署；H11B沿RuntimeAssets deploy→plan/真实GatewayCandidateReplay→activate→Nest HTTP/cache以33场景闭合H01–H12，相关73 suites/1023 tests及API build通过；Range/If-*、gzip/identity、cache分区及直连/bypass有证据，Proxy仅按validated chunked策略重建TE；TP-D1按原出口DONE。旧活动snapshot把compiled policy fingerprint纳入校验，故不得用缺省v1字段绕过迁移使冷启动失败，也不得删除NOT_READY门禁宣称上线。