---
doc-version: 0.3.0
doc-status: reviewed-slice
doc-updated: 2026-09-16
---
# 托管 MCP 凭据交付设计与验收契约

SEC-E1-01 为草案交付；SEC-E1-01R 已完成代码链技术审查。第2–8节保留当时的总体设计与建议，第9节记录02A技术冻结；已完成02A/B1/B2的实际范围、后续边界以第10节和[统一子任务台账](./active-work-package-execution-status.md)为准。本文不表示整个方案获产品批准或受管生命周期已接入。关联 TP-E1/C4、F3；OAuth2、协议升级和完整 SSRF 不在本切片内。

## 1. 已核对的实际调用链

- `packages/api-nova-api/src/modules/runtime-assets/services/runtime-assets.service.ts`：装配已从单语句读取归属/profile/publication，向进程内 `transformOpenApiToMcpTools` 第9参数传可信映射；仍未启用 single-hop。部署保存 OpenAPI/工具元数据及 candidate revision，handler 闭包不能随 JSON 持久化。
- `packages/api-nova-api/src/modules/servers/services/server-lifecycle.service.ts`：`buildCliArgs` 生成 `--openapi` 管理 API URL，还会生成 `--bearer-token`、`--custom-header name=value`。`startServer` 把 auth/custom headers 同时放入 mcpConfig，并继承父环境。
- `packages/api-nova-api/src/modules/servers/services/process-manager.service.ts`：spawn 当前是三条 pipe、Windows `shell:true`，没有 IPC；spawn 得到 PID 就标 RUNNING。配置进入 ProcessInfo，不可把敏感交付内容直接加到持久化 config。
- `packages/api-nova-server/src/cli.ts` → `src/cli/index.ts` → `src/server.ts`：普通 CLI 解析后调用 transport runner；`createMcpServer` 每会话创建并注册工具。ServerOptions 目前不接收可信绑定/单跳 policy。
- `packages/api-nova-server/src/tools/initTools.ts`：通过工具缓存调用 transform；其 options、缓存和调用尚未透传可信映射/Registry 闭包。`src/core/Transformer.ts` 与 `src/transform/transformOpenApiToMcpTools.ts` 已有透传，不需复制 Parser Resolver。
- Parser 已有 `trustedOperationBindings`、`upstreamCredentialPolicy: {mode:'single-hop', captureSnapshot}`；None/解析失败/不可变身份/零自动重定向已有源码测试，不能重列为待开发。

缺口是可信管理数据跨 child 边界的实际交付，以及托管 child 的真实工具发送链；仅继续修改管理装配不完成 E1。

## 2. 推荐方案及信任来源（待冻结）

采用**专用 managed child 入口 + 父进程创建的 Node IPC**，不复用普通 CLI 的 bearer/custom-header 参数解析。普通独立 CLI 保留 legacy，托管安全模式显式启用，不由 OpenAPI、HTTP 参数、`MCP_MANAGED=true` 或任意 `x-*` 开启。

信任依据是：有管理权限的部署流程从受信数据库读取归属，受控父进程启动指定的随产品发布 child 文件，并仅向自己持有的 ChildProcess IPC 句柄交付数据。child 不开放“接受交付”的 HTTP/TCP 服务，不从 argv/environment 读取 JSON 凭证包。普通 OpenAPI 请求、Tool 参数、客户端认证或 Session ID 都不能产生可信绑定。

IPC 不证明对同 OS 用户/管理员或已被攻陷父进程的隔离；该威胁不靠随机 nonce 或文件 hash 解决。nonce 仅防当前 child 会话中的陈旧/重复消息，hash 仅作内容一致性，不是来源签名。

建议首版每 runtime 使用一个**运维预配置、不可由部署请求改写的 Registry source 描述**。描述至少含 runtime ID、source 配置标识、固定绝对文件路径、格式、environment、允许的 Source Asset ID 集合。由只读 ConfigService/受保护配置文件提供，HTTP DTO 只可选择已授权标识，不可提交路径、Provider 根目录或 Secret。配置管理权限与 runtime 部署权限分别校验；部署权限不意味着能引用其他源资产。

首版推荐固定配置 source 专用于该 runtime，避免 child Dry Resolution 读取无关站点秘密。是否允许一个共享 Registry 源覆盖多个 runtime，是待决策项；若允许，必须落实资产授权与最小凭据可见性，不能只按 OpenAPI 中出现的 ID 自动授权。

## 3. 父端准备与交付契约

建议新增内部类型 `ManagedMcpHandoffV1`，仅存在内存与 IPC，不进入 ProcessInfo/HTTP 响应：

```ts
interface ManagedMcpHandoffV1 {
  version: 1;
  launchId: string;
  managedServerId: string;
  runtimeAssetId: string;
  candidateRevision: string;
  verificationRunId: string;
  behaviorFingerprint: string;
  transport: { type: 'streamable' | 'sse'; host: string; port: number; endpoint: string };
  openApiData: unknown;
  trustedOperationBindings: readonly TrustedOperationBinding[];
  registrySource: {
    configId: string; path: string; format: 'json' | 'yaml'; environment: string;
    expectedRevision: string; expectedContentDigest: string;
  };
}
```

以上是建议接口，字段名/限额尚未批准。不得包含 `bearerToken`、解析后的 header、Secret Value、任意 authConfig/customHandlers 或调用方提供的 Provider。

父端准备顺序：

1. 校验管理主体当前权限及 runtime/server 对应关系，读取固定源授权映射；自动重启也走同一准备服务，不从 ProcessInfo 恢复旧交付包。
2. 从数据库读资产归属并生成绑定；使用**已验证候选对应的行为内容**。不能把旧 candidateRevision 与重新组装的新 OpenAPI 拼接。重新组装时 fingerprint 必须匹配，否则返回 `MCP_HANDOFF_CANDIDATE_STALE` 并重新规划验证。
3. 校验候选/当前资产/已记录 binding revision 的现有 guard；这些是读取时点检查，不是跨进程 CAS。取得经稳定读取及校验的 Registry revision/content digest。代际 generation 为进程本地值，不用父 generation 冒充 child generation。
4. 检查源配置授权覆盖全部可信绑定，拒绝其他资产/缺 endpoint。只发送精确绑定清单与对应 OpenAPI；所有 operation 必须一一覆盖。
5. 在受控 IPC 通道发送一份有界包。建议上限：整体8 MiB、绑定最多10,000、30秒启动超时；按字节而非字符串字符计数。超过限制拒绝，不能截断。数值待冻结。

Registry 文件只包含引用，不证明整个 OpenAPI 无秘密。新模式须拒绝/移除旧认证执行扩展；不得将 bearerToken/custom header value 藏进 OpenAPI、IPC、数据库工具快照后称为“无 argv Secret”。现有业务样本含秘密的全面治理仍属 F3，验收使用植入合成敏感值验证已覆盖渠道。

## 4. Child 启动、版本与发送

建议状态：WAIT_HANDOFF → VALIDATING → READY → STOPPING；父端另记录失败/超时。创建 PID 不算 READY。

- 专用入口要求 `process.send`/有效 IPC，缺通道、未知version、重复交付、未知字段、超限或ID不符固定拒绝；不从普通 CLI、默认 swagger、远程 OpenAPI URL 或 env 补齐。
- 接收一次后复制/冻结必要数据，编译可信绑定。校验 behaviorFingerprint 与交付内容，固定源 Stable Read、Registry reloadFile、environment/expectedRevision/contentDigest 必须一致；读到更新版不能自动接受，返回 `MCP_HANDOFF_REGISTRY_STALE` 由父端重新准备。
- Registry digest 必须对应**实际装载的那次内容**。禁止先独立hash再reloadFile的TOCTOU；实现需给现有稳定读取/Registry加载提供同一份字节的版本校验接缝，或在加载事务内校验digest。
- 每个 child 持有一个 Registry；每个 HTTP 调用捕获一次当前冻结快照。每会话 createMcpServer 使用同一受信闭包，传递给 tools/initTools → transform 第9/10参数。
- 首版新模式禁用 preparedToolCache 或按不可伪造的交付对象身份隔离；不能仅按 OpenAPI hash 命中其他身份/Registry 的旧 handler。建议先禁用该模式缓存以缩小验收。
- None 不恢复 authManager、旧 env header、default Axios 认证或消费者凭据。禁止 customHandlers；继承原型/后续mutation回归仍保留。请求固定 maxRedirects=0，3xx原样返回，不默认尝试第二跳。
- 初次完整校验在监听端口前完成；父端等待包含launchId、server/runtime ID、candidateRevision、Registry revision的 READY。READY 只证明启动交付成功，不声称上游健康。
- bootstrap失败仅静态码，不打印原异常、路径、包体、headers。断开父 IPC 默认停止接新请求并有界退出；启动超时父端终止 child、清理监听/计时器，不盲目无限重启。

## 5. 秘密渠道、环境与 legacy 边界

- 新模式 argv 仅包含受控入口与无敏感值的进程参数；不传 bearer-token/custom-header、交付JSON或认证值。使用Node可执行文件直接spawn、`shell:false`、第四个stdio为`ipc`；Windows专门验证，不能继续通过shell展开。
- ProcessConfig 分离可持久的启动描述与一次性内存交付能力；ProcessInfo/API/日志不得序列化交付包、env值、旧mcpConfig.authConfig/customHeaders。重启/错误恢复路径同样检查。
- 新模式不能在 ProcessManager 再次 `{...process.env}` 撤销父端环境过滤。建议允许必要系统运行项及已批准 Provider 引用的env名称，不继承管理 JWT/DB 凭据等无关项。入站 MCP 私有认证与上游凭据是不同配置域：逐项列出必需入站配置及安全来源，不能因过滤环境使 child 降级匿名。
- File Provider 仍受已有固定根目录/权限限制。Windows ACL、Linux权限的未验收项不因改用IPC而消失。
- 旧独立 CLI 保留现状且不计为安全模式。已存托管 bearer/custom header 配置不自动迁移秘密；建议新模式明确拒绝，要求运维先建立Secret Reference。legacy托管记录是否允许继续启动是待决策项，不能一面允许含秘密argv一面宣布E1整包完成。
- parent/child版本不匹配拒绝；无自动退回旧CLI。首版 Registry 热更新推荐通过重新准备并重启 child；Watch/跨进程推送协议不夹带实现。

## 6. 实际改动文件与实现边界

| 文件/接缝 | E1-02 必要改动 |
| --- | --- |
| API `runtime-assets/services/runtime-assets.service.ts` | 交付已验证行为与可信绑定的准备数据，fingerprint不符拒绝；复用已有归属reader/激活guard |
| API 新 `servers/services/managed-mcp-handoff.service.ts` | 固定源配置授权、生成一次性包、静态错误；不提供公开任意路径接口 |
| API `servers/services/server-lifecycle.service.ts` | 显式选择managed安全入口；移除该分支秘密argv/mcpConfig值；调用准备服务 |
| API `servers/services/process-manager.service.ts`、ProcessConfig类型/ProcessInfo序列化 | 专用IPC、shell:false、环境准确替换、READY与超时、持久状态投影；不得全局破坏其他进程 |
| API `servers/services/process-error-handler.service.ts`及restartProcess链 | 重启重新获取交付，不回放过期包，不重新拼秘密CLI参数 |
| Server 新 `managed/entry.ts`、`managed/handoff.ts` | 有界单次IPC bootstrap、版本校验、Registry初始化、固定错误及断连停止 |
| Server `server.ts`、`tools/initTools.ts` | ServerOptions和每会话factory透传可信绑定/闭包；新模式缓存隔离及禁止默认配置回退 |
| Server package构建/产物定位 | 发布并定位专用入口，不假定开发src路径在离线包存在 |
| Parser Registry/稳定文件读取接缝（必要时） | 同一次加载字节的expected digest/revision校验；复用Resolver，不复制凭据规则 |

普通 CLIAdapter/lib调用不应因新增managed分支隐式启用安全模式。入站认证现有每请求验证和工具授权必须保留。

## 7. 隔离 child 验收矩阵（E1-03）

全部使用临时目录、合成秘密与受控loopback upstream；不读取真实部署配置。测试启动真实产品child入口，不能只mock transform或父端spawn。

| 场景 | 必须可观察的结果 |
| --- | --- |
| 正常API Key/Bearer | child收到正确身份，真实HTTP请求仅当前上游凭据，消费者值不出现 |
| None，父Axios/旧auth/env污染 | 真实上游无认证回退；非托管业务头按已批准策略处理 |
| 缺/重复/cross-asset绑定、伪造x-* | READY前拒绝或调用前固定拒绝，upstream计数0；Tool参数不能替换身份 |
| Registry内容/revision在准备后变更 | child拒绝旧期望，不使用“最新”内容冒充已核验版本 |
| OpenAPI/candidate fingerprint不匹配 | 父端拒绝spawn或child拒绝READY，不更新成功启动状态 |
| 无IPC、重复包、错version/launchId、超限 | 固定失败，无默认swagger/远程URL回退；进程和计时器清理 |
| 多Session/两个runtime相同OpenAPI | 分别使用正确binding/Registry闭包，不跨prepared cache复用 |
| 302到另一目标 | 第二目标零请求，秘密/正文不重放 |
| spawn成功但bootstrap失败/超时 | 不标RUNNING/READY；现有可用实例是否保留按批准切换策略验证 |
| 自动重启、错误恢复、父断开 | 不回放陈旧包；重新准备或停止，既有授权边界不绕过 |
| argv/ProcessInfo/日志/异常/审计扫描 | 植入合成秘密后所有列举渠道无完整值；实际child argv验证，不只检查buildCliArgs |
| 入站认证环境裁剪 | 无身份仍拒绝；JWT/API Key和Session逐请求授权不退化 |
| Windows/Linux | direct Node spawn+IPC+退出清理；File Provider权限分开记真实通过/缺证据 |

不以该矩阵证明DNS/SSRF、同OS用户隔离、跨进程CAS或即时撤销。自动重启成功也不代表变更传播已经验收。

## 8. 拆分、退出条件与待决策

- **SEC-E1-01 设计交付**：本文、实际文件链与可执行验收矩阵齐全，待父任务审查；不是实现DONE。
- **SEC-E1-02 实现**：实际managed child从受信准备服务启动并走共享Resolver；权限/固定源/版本/缓存/环境/READY/重启拒绝链齐备，定向测试通过。不再重复开发纯Resolver和已有归属reader。
- **SEC-E1-03 端到端**：执行第7节真实child矩阵、平台证据、泄漏扫描与构建产物验证；指出legacy托管存量是否仍暴露argv。E1-02单元测试不能代替此出口。
- **SEC-E1-04 撤销与运行中变化**：定义credential/policy/runtime revision传播、旧session与下一调用行为、失联/过期策略、进行中请求边界及多child证明。与B1/B3/C3协作；首版重启交付不算即时撤销。

实施前需冻结（以下仅推荐）：

1. 专用IPC入口及runtime固定Registry配置来源；首版每runtime独立源。
2. 显式启用范围和旧托管秘密参数记录的处置；推荐安全模式拒绝旧值、不自动迁移。
3. 父端如何取得与验证候选一致的OpenAPI+bindings；若当前持久数据不足，允许重组后fingerprint拒绝，不假定可无条件启动历史记录。
4. 入站认证必需环境项与Provider秘密env白名单；推荐准确替换、不继承整个父环境。
5. 包上限/启动超时/父断开停止、READY定义；推荐8MiB/10,000绑定/30秒，尚待确认。
6. Registry更新首版是否限定受权重新准备+重启；推荐如此，Watch/即时撤销留E1-04。
7. 已运行实例的切换策略；现有流程是否支持旧实例保留须实现时核实，不能预先承诺无停机。

决策未冻结前，不标设计为Approved，不把建议默认值当成用户已批准的产品策略。

调度编号细化：原SEC-E1-02现在拆为SEC-E1-02A安全启动通道、02B child可信映射/Resolver、02C重启及legacy边界；SEC-E1-01R负责本草案技术审查后再进入实现。编号与状态以[统一划分](./active-work-package-breakdown.md)为准。

## 9. SEC-E1-01R 技术审查结论与02A冻结（2026-09-15）

状态：**01R技术交付完成，提交父任务复核；02A范围READY、尚未实现。** 本节是现有开发授权内的技术取舍，不要求用户因第8节曾写draft而再次批准普通实现。它不授权生产启用、存量秘密迁移或修改其它任务状态。

### 9.1 可直接执行的技术默认

| 审查点 | 02A冻结选择 | 代码依据与边界 |
| --- | --- | --- |
| IPC | 独立`managed/entry.ts`，Node直接spawn，第四stdio为ipc；shell=false | 现有ProcessManager三pipe+Windows shell:true不能满足；不改变普通进程路径 |
| 来源 | 仅父端自己创建ChildProcess的IPC；一次launchId+version校验 | 不开放HTTP交付口；nonce/hash不是身份认证，不对同OS主体作隔离保证 |
| 权限 | 新通道是内部服务方法，不新增Controller/DTO，不允许请求指定scriptPath/Registry路径/env | 02A不绕过现有发布/启动权限；产品入口尚不开放，02B父端准备层负责复核资产/固定源授权 |
| 环境 | 新方法使用完整构造的env，不再展开process.env；缺输入不补父环境 | 旧startProcess保持原逻辑。02A不承载业务认证运行，因此不得把缺失认证解释为anonymous |
| 系统env | 仅复制存在的PATH/SystemRoot/WINDIR/COMSPEC/TEMP/TMP/TMPDIR/HOME/USERPROFILE/LANG/LC_ALL/TZ；键名按平台处理，值不记日志 | 直接Node执行不依赖shell；禁止默认继承NODE_OPTIONS/NODE_PATH、代理变量、JWT_SECRET、DB_*、API_NOVA_*业务项 |
| 业务env | 内部调用方可提供按精确名称授权的值映射；键须存在于独立approvedNames集合，拒绝NODE_OPTIONS/NODE_PATH/NODE_CHANNEL_FD等运行时注入项 | approvedNames由受信配置准备层给出，不来自IPC/HTTP/OpenAPI；02A夹具只用SYNTHETIC_*，02B再接入实际Provider与入站认证集合 |
| 大小/时间 | 父端JSON UTF-8编码后≤8MiB、绑定≤10,000；通道握手30秒；停止等待5秒后强制结束 | 技术有界默认，单调计时；child反序列化后复查大小。IPC接收器不是对恶意同OS进程的内存DoS防线 |
| 状态 | `handoffAccepted`仅表示通道/包结构接受；**不是READY/RUNNING** | 02B完成绑定/Registry及服务监听后才允许runtimeReady；PID和通道ACK都不能触发现有启动成功事件/健康检查 |
| 失败 | 静态错误码、超时/断开清理listeners/timers/child；无自动legacy回退 | 错误不包含包体、env、文件路径或原始异常；02A不启动业务监听 |
| legacy | 原CLI/原startProcess不变，新通道不接受bearer-token/custom-header/mcpConfig.authConfig | 02A不得宣称旧托管argv问题已消除；禁用自动迁移与隐式启用 |
| 自动重启 | 02A通道失败不复用旧包且不自动重启 | 02C才接入现有restartProcess/process-error-handler；禁止用缓存包临时兼容 |

`API_NOVA_RUNTIME_AUTH_MODE/API_NOVA_RUNTIME_API_KEYS/API_NOVA_RUNTIME_ISSUER/API_NOVA_RUNTIME_JWKS_URI/API_NOVA_RUNTIME_JWKS_JSON/API_NOVA_RUNTIME_REQUIRED_SCOPES/API_NOVA_MCP_RESOURCE/API_NOVA_RUNTIME_RESOURCE/API_NOVA_MCP_TOOL_SCOPES`是已读实际入站配置键，不是02A默认继承白名单。02B必须从受信输入逐项准备并验证，不能仅过滤环境后直接运行现有runtime-auth默认分支。

### 9.2 02A实际文件与内部接口

02A交付一个能启动**真实专用child并完成受信交付/关闭**的内部通道，不将未完成的02B服务器伪装为可用。不是只定义DTO或mock spawn。

新增文件建议：

- API `src/modules/servers/services/managed-mcp-channel.ts`：直接Node spawn、准确env、消息状态机、超时/关闭、一次性内存值；由现有servers代码层内部调用，不新增HTTP入口。
- API `src/modules/servers/services/managed-mcp-channel.spec.ts`及`scripts/test-managed-mcp-channel.cjs`：纯状态边界与真实child回归。
- Server `src/managed/entry.ts`、`src/managed/handoff.ts`：独立进程入口、结构/版本校验、握手、父断开停止，尚不注册MCP工具或监听业务端口。
- Server 导出一个严格wire contract入口供API和Server共用；不能把两个独立消息schema复制维护。构建入口路径固定在产品包内；路径解析覆盖源码夹具和构建产物。

必要局部修改：Server package出口/编译产物定位；API ProcessConfig/ProcessInfo仅在确需使用现有投影时增加**非敏感**通道状态。02A优先独立内存handle，避免把payload塞入现有`config`再到处打补丁。`server-lifecycle.service.ts`生产启动分支在02B前不切换；02A实际集成出口就是内部managed通道调用与真实child，02B必须消费此通道，不再另写spawn。

建议冻结内部函数形状（实现时可调整命名，不改变约束）：

```ts
startManagedMcpChannel(input: {
  launchId: string;
  serverId: string;
  // child entry为模块内部定位；不允许调用者提供任意scriptPath/args
  payload: ManagedMcpHandoffV1;
  approvedEnvironmentNames: readonly string[];
  environmentValues: Readonly<Record<string, string>>;
}): Promise<{
  launchId: string;
  pid: number;
  state: 'handoffAccepted';
  close(): Promise<void>;
}>;
```

该handle不挂到HTTP响应、不序列化env/payload、不触发ProcessStatus.RUNNING。通道ACK后由02B运行时启动阶段发送`runtimeReady`。冻结的02A行为是：实际entry接收并验证handoff后发送ACK，然后因02B尚未实现而发送固定`RUNTIME_ACTIVATION_NOT_IMPLEMENTED`并退出；父端记录通道接受与运行时失败两个不同事件，不报启动成功。02B在同一entry中替换该拒绝分支为实际bootstrap。真实child测试必须验证这一完整行为，不能用模拟READY冒充可用服务。连接层单元测试可用包内测试entry验证超时/乱序，但不允许由IPC字段指定模块、script或函数。
wire消息按方向分离：父→child只有`handoff(version,launchId,payload)`和`stop(launchId)`；child→父只有`handoffAccepted(launchId)`、`runtimeReady(launchId,nonSecretRevisions)`、`failed(launchId,staticCode)`。02A父端不接受未知/重复/错方向READY作为成功；有界关闭不得依赖stdout解析。消息权限由私有通道和状态机共同限制。

### 9.3 02A必选验收与交付证据

以下来自第7节的通道相关子集，均为02A退出条件；运行凭据矩阵保留02B/03，避免循环要求：

1. 真实Node child、shell:false、pipe/IPC组合；child读取自己的argv，验证无合成Secret、JSON包和旧秘密参数。
2. Parent→child精确环境：允许的合成项可见，父端额外SYNTHETIC_PRIVATE/NODE_OPTIONS/管理秘密项不出现；ProcessManager不再次补回父环境。入站认证缺失时没有业务监听，不产生anonymous服务。
3. 缺IPC、未知version、错launchId、重复消息、未知字段/超限包固定拒绝；无默认swagger/URL获取。
4. PID/ACK不等于RUNNING；02B不存在时无runtimeReady成功事件、无健康检查、无业务监听。
5. 超时、父断开、主动stop、child提前退出都清理进程和句柄；重复close幂等，不用forceExit掩盖泄漏。
6. wire payload只存在内存；捕获日志/异常/可序列化状态，确认env值/交付包/合成秘密没有进入ProcessInfo或响应。
7. 原CLI/旧startProcess回归不改变参数语义；显式新通道无legacy回退。
8. 当前Windows必须真实执行；Linux可用同脚本补证，缺平台如实记为待证据，不宣称跨平台全验收。

可输出02A代码完成及本机通道验收结果；只有02B+02C+03完成才能称托管单跳发送链可用。02A不关闭E1父包，也不关闭CLI秘密全渠道治理。

### 9.4 后续决策与不阻塞02A的边界

现在**没有必须向用户提问才能实施02A的事项**。允许在已有授权下开发隔离通道与拒绝型测试；默认不启用生产和存量迁移，避免因一般技术选择新增审批。

以下在02B/02C接产品入口前处理，不以“全部待决策”阻断02A：

- 固定Registry source注册：技术基线为每runtime单独、运维受保护配置；配置格式可在02B自行设计并验证。若希望允许跨runtime共享/委托源资产，才需要产品权限语义决定。
- 新/存量托管记录启用：02B仅新增显式模式且默认不自动迁移。是否强制停用既有legacy记录、批量迁移秘密，需要具体产品/运维授权；不能推断用户已要求停机。
- 生效版本：首版静态交付+受权重启；即时撤销、失联租约和在途请求处置由E1-04，不假设已支持。
- 入站认证环境：02B按上列实际键形成运行时契约；任何必要值缺失必须fail closed。涉及新的匿名默认或共享凭证策略才升级为产品决策。
- 无停机切换：未证明旧实例保留能力，不承诺。02C完成失败/重启语义；改变既有停机策略时单独说明实际影响。

01R退出依据：已对照统一拆分§SEC-E1-01R/02A、实际spawn/CLI/ServerOptions/initTools/runtime-auth代码审查，确定安全技术默认、真实child首片与必选验收；未运行代码或测试，未改变统一台账。父任务可据此登记01R完成并排入02A。
## 10. 当前实现证据与未接入边界（2026-09-16）

| 子项 | 已验证范围 | 尚不能推导 |
| --- | --- | --- |
| SEC-E1-02A | API内部受管通道直启真实Node child，shell:false、四路stdio含IPC、精确环境、内存交付；ACK与READY分离，超时/断连关闭；真实child通道11/11、原ProcessManager回归3/3 | 不能由PID/ACK标RUNNING；不代表产品生命周期已切换 |
| SEC-E1-02B1 | 受保护ConfigService Registry来源、资产/绑定/候选双次DB重读、稳定文件摘要与环境核验，准备一次性handoff；专项23/23 | 不是跨进程CAS，也不允许HTTP提交任意Registry路径 |
| SEC-E1-02B2 | child再次稳定读Registry并核验revision/digest；标准Streamable/SSE工具处理器使用共享single-hop Resolver，监听后READY；三脚本联合47/47 | 仅合成Registry与回环上游；尚不是现有产品startServer的完整入口 |

首版实现仅支持可信Registry中按endpoint ID的覆盖；method/path覆盖未纳入当前02B2出口。入站MCP客户端认证在此运行时限定为已配置API Key；匿名、缺认证或JWT配置在监听前失败。上游凭据采用每次调用的单跳决议，None或缺Secret不从旧配置/消费者身份回退，302不自动跟随。该结果不覆盖F3完整网络边界。

SEC-E1-02C1的本地未验收生命周期接线草稿已撤回；自动审批要求明确授权改变生产托管启动/停止状态行为后才可继续。因此现有产品Server启动流程仍未通过02B1/B2的受信handoff集成验收，不能以独立child的READY推断现有服务RUNNING安全。02C2的重启/失败/legacy和03的真实产品路径单跳验证继续等待。旧CLI与已存托管秘密argv无自动迁移；运行中撤销/版本变化留给04。没有真实业务Registry、PostgreSQL/Linux或生产部署证据。