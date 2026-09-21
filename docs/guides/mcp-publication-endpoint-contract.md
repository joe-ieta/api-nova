---
doc-version: 0.2.0
doc-status: active
doc-updated: 2026-09-21
---
# MCP受管发布端点合同

PROD-01交付：源码核查及PROD-02实施合同。本文中的“实施要求”是依据既有产品边界选定的技术方案，尚不是已实现能力或新增产品批准。该子任务完成不关闭DEV-01、WP-60或任何安全父包。

## 1. 范围与源码依据

范围是已有运行时资产的受管MCP发布、停止后修改和重新部署，以及发布前地址预览。保留现有streamable/SSE传输与验证后激活流程；不增加OAuth、协议版本升级、stdio受管监听、公网域名配置或自动反向代理。

| 环节 | 当前源码事实 | PROD-02欠缺 |
| --- | --- | --- |
| 发布DTO | `DeployRuntimeAssetMcpDto`接受可选port/transport；port使用IsNumber+1024..65535，transport仅IsString；无endpointPath | 整数/枚举校验与路径字段 |
| 发布保存 | `deployMcpRuntimeAsset`新建可自动选端口；保存mcp_servers.port/transport；config用于受管归属/验证信息 | 路径保存、统一有效配置解析、更新语义修正 |
| 更新 | desiredTransport在查到原server前就默认streamable；省略transport也可能覆盖SSE，运行中拦截仅检查显式参数 | 更新省略字段必须保留现值，校验实际有效差异 |
| 生命周期 | `buildCliArgs`读取config.endpoint生成`--endpoint`；mcpConfig和getServerEndpoint也读取相同字段，缺省为/mcp或/sse | 发布输入尚未接入这一现有能力；启动前统一校验 |
| 传输 | Streamable在同一路径处理POST/GET/DELETE；SSE的GET入口为endpoint，POST入口为endpoint后追加/messages | 验证自定义路径经过受管链后仍相同 |
| 主机 | CLI默认host=127.0.0.1；共同HTTP server缺省也监听127.0.0.1；生命周期展示localhost | 固定区分本机地址与公网地址，避免把管理API主机当MCP主机 |
| 地址读取 | managedServer summary返回entity.endpoint、port、transport；entity.endpoint为运行结果地址，config.endpoint才是路径；现有gatewayGovernance.accessUrls仅用于Gateway | 返回已解析端点配置与独立预览，不滥用Gateway accessUrls |
| UI | EndpointRegistry、ServerManager及RuntimeAssetDetail实际调用deployMcpRuntimeAsset，多数不传端点参数；API客户端payload为泛型Record | 统一有类型表单、预览、保存及重部署接线 |

源码入口：

- [发布DTO](../../packages/api-nova-api/src/modules/runtime-assets/dto/runtime-assets.dto.ts)
- [部署、自动端口及managedServer摘要](../../packages/api-nova-api/src/modules/runtime-assets/services/runtime-assets.service.ts)
- [运行时资产HTTP控制器](../../packages/api-nova-api/src/modules/runtime-assets/runtime-assets.controller.ts)
- [MCPServer实体](../../packages/api-nova-api/src/database/entities/mcp-server.entity.ts)
- [受管生命周期](../../packages/api-nova-api/src/modules/servers/services/server-lifecycle.service.ts)
- [CLI默认值](../../packages/api-nova-server/src/cli/defaults.ts)、[共同HTTP监听](../../packages/api-nova-server/src/tools/httpServer.ts)
- [Streamable路由](../../packages/api-nova-server/src/transportUtils/stream.ts)、[SSE路由](../../packages/api-nova-server/src/transportUtils/sse.ts)

## 2. 端点字段与默认值（实施要求）

新增公开字段`endpointPath`，内部落到现有`MCPServerEntity.config.endpoint`，不新增平行权威字段或数据库列。`entity.endpoint`继续是启动结果URL，不能拿它反推或覆盖配置路径。

| 字段 | 新建时省略 | 已存在时省略 | 显式值校验 |
| --- | --- | --- | --- |
| transport | streamable | 保留原值 | 仅streamable、sse，大小写严格；拒绝stdio和任意字符串 |
| port | 自动分配；沿用9022..10021有界候选范围 | 保留原值 | JSON number、整数1024..65535；拒绝字符串、null、小数、0 |
| endpointPath | 按有效transport：streamable=/mcp，sse=/sse | 保留已有config.endpoint；不存在则按有效transport默认 | 1..256个ASCII字符，以/开头，由非空路径段组成；段只允许A-Z/a-z/0-9/_/-；拒绝根路径、尾斜杠、重复斜杠、空白、点段、百分号编码、反斜杠、查询/fragment、完整URL及控制字符 |

保留`/health`及其子路径，不能用作MCP入口；SSE的消息入口由服务器追加`/messages`，不是第二个可编辑字段。拒绝非法输入而不是静默trim、解码、补斜杠或改写；UI可即时提示，服务端仍是权威。

显式切换transport且省略endpointPath时，已有自定义路径保持不变；缺失配置才按新transport选默认值。UI切换transport时可提供“使用该传输默认路径”动作，必须明确改变表单值，不能暗改已保存路径。

已有非空但不满足新路径规则的配置不能在部署/启动时静默回退默认；返回需修正的字段错误。读取可显示原值和不可用原因，不提供错误地址的成功预览；不批量重写历史配置。

## 3. 保存、验证与启动一致性（实施要求）

1. 从已授权runtimeAsset及其受管server解析目标；不得仅凭UI提交的targetServerId把另一资产的server接管。现有按名称查找也须核对config.runtimeAssetId归属，冲突拒绝。
2. 单一纯函数解析有效transport/port/endpointPath，供预览、部署保存、summary和生命周期使用。新建与更新默认值必须分开；所有生命周期入口（包括redeploy）必须保留已保存路径。
3. running/starting/stopping时，三项有效值发生变化均返回409，提示先停止再部署；省略或提交相同值不得改写监听参数。不要自动停机。停止后修改仍经过现有候选验证/激活，不能新增绕过验证的直接保存接口。
4. 保存时合并config.endpoint，保留可信归属及验证信息。候选身份/验证记录应包含这三项端点配置，避免仅工具正文指纹相同就将改变监听参数视为同一候选；实现不得削弱已有陈旧候选拒绝或失败回滚。
5. 端口预检既检查其它受管server记录，也检查本机可绑定性；自动分配不表示已持有监听socket。预览和预检都不构成端口租约，真实bind失败须报告失败，不能改用另一个端口后仍返回原预览。跨进程端口排他不是本子任务已验证能力。
6. 启动从持久化的有效配置生成CLI参数和mcpConfig；监听确认后更新运行结果URL。保存/候选验证成功不等于进程已监听或消费者可用；保留autoStart=false默认与现有启动授权。

## 4. 预览与访问地址（实施要求）

为避免UI复制后端默认逻辑，PROD-02新增只读语义的授权预览操作：`POST /api/v1/runtime-assets/:id/mcp-endpoint-preview`，输入为同一端点字段及可选targetServerId。它使用现有管理认证与该资产部署权限，不保存、不验证工具、不启动进程、不分配端口。该路径为拟新增，当前控制器没有此接口。

返回有类型的`transport`、`port: number|null`、`portMode: explicit|existing|automatic`、`endpointPath`、`consumerUrl: string|null`、`messagesUrl: string|null`、`addressScope: loopback`、`availability: not_checked`。非法配置直接返回400；归属冲突/运行中有效配置变更返回409。错误码可由PROD-02复用仓库约定，但不能只返回成功对象内的隐式错误。

- 新建且port省略：返回port=null、consumerUrl=null；显示“部署时自动分配端口”，可以展示路径，不把9022候选写成已确定完整地址。要求部署前确定完整URL时，运营方填写显式port。
- 显式或已有port：预览`http://127.0.0.1:{port}{endpointPath}`。streamable messagesUrl=null；SSE messagesUrl为consumerUrl追加/messages，仅供解释传输，实际会话参数由协议处理。
- 预览为服务所在机器的回环地址；不能拿window.location、管理API反代Host或X-Forwarded-*拼成公网地址，不能宣称远程客户端可达。公网HTTPS/路径映射需另有部署配置和验收，不在本合同补造。
- 部署返回和managedServer摘要增加有效endpointPath与相同配置预览；实际运行状态/实际endpoint单独显示。端口未分配、未启动或探测失败时不能显示“已连接”。
- 受管Server监听路径不带管理API的`/api`前缀；上述预览HTTP操作带`/api`，两者不可混淆。

## 5. PROD-02实施边界

PROD-02是端点合同落地与真实发布入口闭环，不是仅加三个控件：

- API：DTO严格校验、归一化/解析服务、预览操作、部署/重部署/summary消费、运行中冲突与归属检查；维持已有事务和激活守卫。
- Server/lifecycle：复用已有endpoint能力，统一参数解析；按实际受管启动方式验证host、path和SSE消息路由一致。只在证据显示接线不一致时修改通用传输。
- UI：在EndpointRegistry发布工作台使用共享MCP部署表单（不拆整页）；ServerManager和RuntimeAssetDetail的部署/重部署入口复用或明确跳转到该表单。typed API替代无约束Record；zh/en文案；编辑回填现值、展示预览与真实状态。
- 异步：预览有界超时，字段修改/切资产/登出后废弃迟到响应；部署失败保留草稿与明确错误，不能自动重放部署；其它入口不得继续无参数调用覆盖配置。
- 不扩展认证类型，不把上游凭据作为消费者凭据；不实现OAuth、公网域名/反代自动配置、自动端口抢占、真实部署或数据库迁移。

## 6. PROD-02退出验收

| 场景 | 必须证据 |
| --- | --- |
| 严格字段 | 真HTTP DTO拒绝非法enum、null、字符串/小数port及上述非法路径；正常多段路径通过 |
| 默认与保留 | 新建默认streamable；自动port预览不伪造URL；现有SSE省略transport仍是SSE；现有自定义路径部署/重部署后保留 |
| 保存/读取 | 同一配置从请求→持久config.endpoint→summary/preview→CLI/mcpConfig一致，无另一字段覆盖 |
| 运行中与并发 | running/starting/stopping改任一项拒绝；停止后合法更改经过验证；他人server归属拒绝；端口竞争/bind失败不伪报成功 |
| 真实传输 | 隔离回环启动受管streamable与SSE，各使用自定义路径；Streamable初始化/GET/DELETE命中该路径，SSE事件发布正确/messages路径；错误旧路径不冒充新地址；/health保留 |
| 验证门禁 | 缺策略/验证失败/陈旧候选不保存激活新配置；失败仍保留此前版本；端点配置变化进入候选身份 |
| 实际UI | 发布入口可编辑、预览、提交和重读回填；API请求确实携带三项；切资产/账号的旧预览不串入；中英文可读 |
| 地址范围 | 预览明确回环/未检查；不从浏览器或反代Host制造公网URL；未启动不等同可用 |

测试日志需标版本、环境、命令及是否真实进程启动；普通mock参数测试不能替代真实传输接线。以上完成可关闭PROD-02/DEV-01的约定端点切片；WP-60完整退出与EXT真实发布、SEC受管信任/撤销和平台验收仍分别核对。

## 7. 本轮交付与决策边界

PROD-01只完成静态源码核查与本合同，没有运行端点功能验收，也未修改代码、数据库或生产配置。端口范围与分配起点沿用实现；路径语法、只读预览形状及更新保留语义是本轮明确的实施选择，不声称此前已获逐字段产品批准。

当前没有必须阻塞PROD-02的产品决策。若后续要求公网HTTPS地址、多主机监听或自定义任意编码路径，应另行明确部署信任与兼容范围；本合同不推定这些需求。

## 入站鉴权模式界面合同（2026-09-21）

MCP发布/重发布弹窗必须明确选择private_jwt、private_api_key或anonymous；新记录、旧unknown和不支持值不默认匿名。保存时提交同一模式，重开按已保存记录回填。模式改变使旧预览失效；运行中改模式本地阻断，服务端状态竞争返回的冲突保留草稿并提示先停止服务。草稿、已配置、预览及实际生效分别显示，实际模式仍unknown。

详情对未部署/null服务安全显示未知，Gateway不显示MCP标签。19项Vue状态/真实SFC模板SSR通过，UI构建和最终类型检查通过；SSR使用组件替身，未执行真实浏览器端到端，不宣称完整后端保存到请求闭环。详见[UI交付证据](../audits/2026-09-21-mcp-mode-ui-evidence.md)。
