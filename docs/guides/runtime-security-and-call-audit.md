# 安全调用与日志审计

> Document status: Active implementation contract
> Last reviewed: 2026-09-06

## 目标与本次范围

Gateway 与 MCP 统一调用记录格式。每次实际 API 调用记录调用者、API 资产、运行实例、调用开始/结束时间、实际请求 Payload 和返回 Response，保留关联标识供后续时间序列与链路分析使用。本次不开发日志分析、统计报表、时间线展示或查询 UI。

本次同时实施安全调用：MCP HTTP 入站逐请求校验，Gateway 可采用相同的外部 OAuth/JWT 或内部 API Key 校验器。不得把未经校验的客户端 Header、IP 或 MCP 会话 ID 标记为已认证身份。

## 改造前的能力缺口

1. `gateway_access_logs` 已关联 `endpointDefinitionId`、runtime、membership 和路由，具有 API 粒度基础。
2. 当前正文仅为 4096 字节预览；multipart 被省略、二进制无预览。`full_body` 只存在于策略解析，未控制实际采集。
3. Gateway 代理提前调用响应 tracker 的 `finalize()`，后续数据被忽略，导致响应正文、字节数和摘要失真。
4. 请求 ID 在多个位置独立生成，无客户端 ID 时上下游与日志 ID 可能不同。
5. `consumerId` 目前为凭证记录 ID；没有跨凭证的稳定主体关联。查询只按写入时间倒序，不支持调用者和时间区间。
6. MCP 工具调用直接进入 parser 的 HTTP 请求，没有与 Gateway 等价的持久化调用记录。连接日志不能替代 API 调用日志。
7. Gateway 仅脱敏四类 Header；Query、URL 和正文缺少统一脱敏。日志落库失败只告警，不能宣称零丢失。

## 记录契约

统一记录包括：schemaVersion、eventId、invocationId、parentInvocationId、requestId、correlationId、transport、runtimeAssetId、serverId、endpointDefinitionId、sourceServiceInstanceId、operationId、toolName、callerId、identitySource、sessionIdHash、startedAt、completedAt、durationMs、outcome、HTTP status、请求/响应及采集状态。

调用开始即生成不可变的内部 ID。客户端 request/correlation ID 作为辅助关联信息，不能作为数据库主键或身份凭证。时间使用 UTC；记录开始、结束与进程内序号，保留并发调用的重叠关系。跨进程按时间重建的是观察顺序，因果关系依赖 parentInvocationId，不能由时间先后推断。

Gateway 记录实际转发的 method、展开后的 URL、Query、Header、body，以及返回数据。拒绝、超时、取消与缓存命中也必须有结果记录；没有上游调用时不得伪造上游 Response。重试分别记录 attempt。

MCP 同时记录 `tools/call` 的参数/结果和其下游 HTTP 调用，使用父子 ID 关联。工具名不是跨发布稳定的 API ID；受管发布需要携带 API 资产与实例标识。独立 OpenAPI 文件没有资产 ID 时，保留 operationId、method、path，不虚构目录关联。

## Payload 与 Response

普通调用保存实际内容，不以 4 KB 预览替代正文。JSON 与表单按敏感字段递归脱敏；Authorization、Cookie、API Key、令牌等凭证不写入日志。URL 的凭证、敏感 Query 也必须脱敏。脱敏状态须显式记录。

正文携带 contentType、encoding、totalBytes、capturedBytes、state 和 SHA-256。JSON 按语义完整保存，格式化空白可能变化；摘要对应采集到的原始字节。正文默认上限 16 MiB，可配置，最大 64 MiB。超过上限时不保存正文片段，记 `omitted/size_limit`；中断记 `incomplete/stream_interrupted`，摘要仅覆盖实际收到的字节。MCP 入站正文超限直接返回 413。

二进制在上限内用 Base64 保存；标准 `multipart/form-data` 保存各字段与文件 part，凭证字段脱敏、文件字节 Base64 留存，可用于追踪实际上传内容。嵌套或不支持的 multipart 格式记 `omitted/unsupported_or_invalid_multipart`。JSON 无法解析时省略正文，避免损坏或截断 JSON 中的凭证泄露。文本采用常见凭证表达式脱敏，但不能识别任意业务机密；上线前需配置业务敏感字段。Gateway 准入拒绝时不读取请求正文，标记未采集；缓存命中保留实际缓存 Response，不伪造上游请求。

## 调用身份

已校验身份应使用稳定的 callerId，并独立保存 credentialId/clientId。API Key 轮换不应改变主体标识。JWT 的主体应结合受信任 issuer，不能仅凭可伪造的 `sub` 文本。

外部调用者无需在 ApiNova 预先注册。OAuth 校验通过后，以 `SHA-256(issuer + NUL + sub)` 生成 callerId，自动追加调用者观察记录，维护 firstSeenAt、lastSeenAt、使用过的协议。同一 issuer/sub 的新令牌保持同一个调用者。内部配置式 API Key 以稳定的 subject 归并，可配置多个不同 key 对应同一 subject；旧 Gateway 数据库 Key 仍按原凭证记录识别，跨 Key 归并建议迁至统一认证模式。

`GET /api/v1/monitoring/management/external-callers?page=1&limit=20` 提供自动发现清单，沿用管理 JWT 与 `monitoring:read` 权限，不返回凭证和 Payload。它不是新调用者注册接口，也不授予访问权限。鉴权失败不登记可信主体；有效身份访问无权工具时仍保留已认证请求记录。不同签发方的同名 sub 不自动合并。

无需“预先注册调用者”并不意味着免认证：运维需配置受信任签发方，调用者仍需取得该签发方授予的访问令牌。OAuth 客户端注册/用户同意由外部授权服务器负责，本项目不实现授权服务器、登录页或任意签发方自动信任。

匿名访问只能记录匿名连接/会话的观察标识。IP、User-Agent 和会话标识均不代表真实用户。跨 Gateway/MCP 可靠归并同一调用者，必须依赖共同的认证主体映射。

## MCP 安全边界

HTTP 授权采用官方 OAuth/Bearer 互操作模型时，必须实现资源元数据、逐请求令牌校验、audience 校验与正确的 401/403 challenge；不可将访问令牌放入 URL，也不可直接透传 MCP 客户端令牌到下游 API。有状态传输须绑定会话与主体，保留 POST/GET/DELETE、SSE 和重连语义。STDIO 使用本机进程/环境边界。

依据：[MCP HTTP Authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)、[MCP Security Best Practices](https://modelcontextprotocol.io/specification/2025-11-25/basic/security_best_practices)。协议版本应独立确认，不在日志改造中隐式升级。

当前实现支持外部授权服务器签发的 RS256/ES256 JWT access token，验证签名、issuer、audience、sub、exp、iat、nbf 和配置的 scope。JWKS 支持受信任 HTTPS 地址或本地公钥 JSON；不支持 opaque token introspection。JWT 撤销依赖短有效期/签发方密钥策略，不宣称即时撤销。OAuth 元数据指向外部签发方，服务自身只充当资源服务器。

MCP 默认 `oauth`，未配置可信验证参数时不放行受保护请求；匿名必须显式选择。会话与 callerId 绑定，POST/GET/DELETE 都重新校验；GET 长流在令牌过期时关闭。默认事件回放缓存按会话隔离。Host/Origin 白名单保留，浏览器预检返回 204，暴露必要 MCP/授权响应 Header。

Gateway 的 `authPolicyRef=oauth` 使用共同 OAuth 身份；`runtime-api-key` 使用共同内部 Key 配置。原 `jwt`/`api-key` 保留管理用户/数据库凭证行为。生产环境缺省策略使用 OAuth；匿名策略需显式设置。不同已认证主体隔离 Gateway 缓存；入站 Authorization、Cookie、API Key 不透传上游，上游凭证通过实例 credentialRef 单独注入。

生产缺省值作用于新编译的路由；已经持久化的部署快照不会被环境变量静默重写。升级时应检查存量路由的 authPolicyRef，并重新验证、部署需要切换到 OAuth 的 Gateway。开发环境仍保留原无策略路由的匿名行为，不能将开发配置直接作为公网配置。

基础 scope 当前在服务进程级配置；MCP 可再按工具名要求更细 scope。Gateway 新 OAuth 模式尚未新增逐路由 scope 编辑器或 QoS 等级体系。多个 MCP Server 若需要分别隔离授权，应在各自受管进程环境中设置不同的 `API_NOVA_MCP_RESOURCE`；同一 audience 表示同一资源授权边界，不能依靠端口或会话 ID 代替授权。

## 配置与启动

这些变量必须设置在 API/受管 MCP 的服务进程环境中。独立 CLI 的 `--env` 文件也支持 `API_NOVA_*` 配置，文件值覆盖当前进程同名变量。源码启动仍统一使用 npm，端口沿用 9000/9001/9022。

| 变量 | 用途 |
| --- | --- |
| `API_NOVA_RUNTIME_AUTH_MODE` | MCP 入站模式：`oauth`（默认）、`api_key`、`anonymous` |
| `API_NOVA_RUNTIME_ISSUER` | 精确匹配的受信任 OAuth issuer |
| `API_NOVA_RUNTIME_JWKS_URI` | HTTPS JWKS 公钥地址，不从客户端 token 指定的地址取钥 |
| `API_NOVA_RUNTIME_JWKS_JSON` | 离线公钥集合，可替代 JWKS URI；不存私钥 |
| `API_NOVA_MCP_RESOURCE` | MCP 对外规范 URL，也是其 JWT audience |
| `API_NOVA_GATEWAY_RESOURCE` | Gateway 对外资源 URL，也是其 JWT audience |
| `API_NOVA_RUNTIME_RESOURCE` | 未分别设置资源 URL 时的后备值 |
| `API_NOVA_RUNTIME_REQUIRED_SCOPES` | 空格分隔的基础调用权限 |
| `API_NOVA_MCP_TOOL_SCOPES` | 工具名到所需 scope 数组的 JSON 映射 |
| `API_NOVA_RUNTIME_API_KEYS` | 内部 Key 配置 JSON，见下文 |
| `API_NOVA_AUDIT_DIR` | 独立调用日志目录；生产必须使用持久化绝对路径 |
| `API_NOVA_AUDIT_MAX_BODY_BYTES` | 正文采集上限；默认 16777216，最大 67108864 |
| `API_NOVA_AUDIT_REDACT_FIELDS` | 额外 JSON/Header/Query 敏感字段名，逗号分隔 |
| `API_NOVA_RUNTIME_ALLOW_HTTP_LOOPBACK` | 仅本地授权服务测试可设置 `true`，允许 HTTP loopback issuer/JWKS/resource |

PowerShell 示例（地址是配置示意，须换成实际可信服务）：

```powershell
$env:API_NOVA_RUNTIME_AUTH_MODE = 'oauth'
$env:API_NOVA_RUNTIME_ISSUER = 'https://identity.example/tenant'
$env:API_NOVA_RUNTIME_JWKS_URI = 'https://identity.example/tenant/jwks'
$env:API_NOVA_MCP_RESOURCE = 'https://runtime.example/mcp'
$env:API_NOVA_GATEWAY_RESOURCE = 'https://runtime.example/api/v1/gateway'
$env:API_NOVA_RUNTIME_REQUIRED_SCOPES = 'api:invoke'
$env:API_NOVA_AUDIT_DIR = 'E:\ApiNovaData\runtime-audit'
npm run dev
```

独立 server 使用相同环境启动 `node packages/api-nova-server/dist/cli.js --openapi ./examples/minimal-openapi.json --transport streamable --port 9022`。仅本机开发需要匿名时，显式设置 `$env:API_NOVA_RUNTIME_AUTH_MODE='anonymous'`。Linux 使用对应的 `export NAME=value` 设置环境。

客户端每次 HTTP 请求发送 `Authorization: Bearer <access-token>`。MCP 元数据位于 `/.well-known/oauth-protected-resource` 及其 endpoint 对应路径；配置的外部地址、反向代理路径和 audience 必须一致。TLS 可以由受信任的反向代理终止，仍须配置 Host/Origin 允许列表；不能通过放开所有 Origin 替代正确配置。

内部 Key 配置为数组，每项包括 `id`、稳定 `subject`、完整入站 Key 的 SHA-256 `secretHash`、Unix 秒 `expiresAt`、允许的 `resources` URL 数组和 `scopes`。客户端通过 `X-Api-Key` 发送原始 Key。配置文件/环境不存原始 Key；不同 Key 可对应相同 subject。该模式是私有接入方式，不宣称通用 OAuth 客户端互操作。

CLI 的 `--auth-type`、`--bearer-token`、`--bearer-env` 仍用于上游 API 凭证，与上述入站鉴权分开。

## 持久化与运维

本次采用独立、追加写入的结构化 JSONL 调用日志作为完整调用证据；既有 Gateway 元数据表保留原有用途。Gateway、受管 MCP 和独立 server 使用同一 schema；进程间共享绝对日志目录，每个进程独立文件，避免多进程行交错。日志不混入 STDIO 协议 stdout，不通过现有普通日志 UI 暴露正文。

默认目录为进程工作目录下的 `data/runtime-audit`，受管子进程继承 API 解析后的绝对目录。调用文件为 `YYYY-MM-DD-<process UUID>.jsonl`；调用者清单使用 `callers-<process UUID>.jsonl` 观察记录，清单接口按 callerId 合并，不读取调用正文。每日切分调用文件，当前不自动删除历史文件。多主机需共同日志存储/收集器，本次只完成单机多进程收集。

目录必须限制为运维授权人员可读，生产配置独立磁盘配额与保留周期。Unix 新建目录/文件使用 0700/0600；Windows 需运维设置 NTFS ACL，不能将 Unix mode 当作 Windows 权限保证。文件本身不额外加密，二进制、文件内容和业务字段可能含敏感信息，需采用受控加密磁盘/备份并设置业务脱敏字段。

写入失败发出不含 Payload 的 `[RUNTIME_AUDIT_WRITE_FAILED]` 告警；本次采用失败放行，不因审计磁盘故障重放或改变业务调用。正常关闭时排空已提交的写入；进程强杀、磁盘故障、尚未结束的长流仍可能造成记录缺失，不承诺审计级零丢失。后续可增加可靠队列、专用日志存储及分析服务。

## 验收

- 真实 HTTP 请求/响应往返，正文大于 4 KB 仍留存；响应摘要与实际内容一致。
- 无客户端 request ID 时，入口、上游、调用记录共享内部关联标识。
- 多调用并发、同一调用者的开始/结束时间与唯一 ID 正确，父子调用不串线。
- JSON、Query、Header 凭证不泄露；不完整内容明确标记。
- 超时、连接拒绝、客户端取消、缓存命中和重试保留可解释的记录。
- MCP 记录 tools/call 与下游 API 的实际参数和返回值，协议输出保持不变。
- 持久化失败可观察；无分析展示变更。

可执行验证命令：

```bash
npm run test --workspace api-nova-parser -- --runInBand
npm run test --workspace api-nova-api -- --runInBand gateway-audit.integration.spec.ts
npm run test:security-audit --workspace api-nova-server
npm run verify:parser-chain
```

实际身份提供方、TLS 反向代理与外部 MCP 客户端的联调记录在 open-items 中；本地测试不能替代这些环境验收。

可追溯用例与本次执行结果见 [安全调用与日志审计验收用例](../testing/runtime-security-audit-cases.md)。本轮未新增调用日志分析/展示页面，未修改 `docs/archive`，未清理业务数据库。

## 2026-09-06 多进程联调补充

已增加 `npm run verify:runtime-security-integration`：临时 SQLite、完整 API 入口、独立 MCP 进程、临时 HTTPS 代理/证书、HTTPS JWKS 服务和 SDK 客户端共同运行。检查对外前缀、资源元数据/challenge、Origin 预检、audience 隔离、JWT 密钥轮换、同主体会话续用、管理鉴权和跨进程调用者归并。API 与 MCP 使用不同的运行资产标识，同一个 API 资产 ID 保持一致。

联调修复两项入口缺口：关闭 Nest 自动追加的正文解析器，防止其提前消费 Gateway 请求流；普通请求日志跳过 Gateway 流式响应，由统一审计器负责采集。管理 API 仍保留 JSON/表单解析。HTTP 异常日志中的敏感 Query 同样脱敏。

干净迁移还补齐了既有配置模块需要的 `config_overrides`、`config_backups`，当前基线为 40 张业务表。关闭 `DB_SYNCHRONIZE` 的部署需要先构建、执行 `npm run migration:run --workspace api-nova-api`，再启动 API；该命令作用于配置的数据库，应先确认目标和备份。迁移 CLI 从当前进程环境读取 `DB_TYPE`、`DB_DATABASE` 等连接参数，不会自动加载 API 的 `.env`；必须显式设置目标，不能依赖应用启动时的配置加载。本次只对隔离临时数据库实际执行了迁移。

测试只信任本次生成的临时证书，不关闭 TLS 验证，不修改系统证书库。Windows 默认使用 Git 附带的 OpenSSL，也可通过 `API_NOVA_TEST_OPENSSL` 指定路径；Linux 使用 PATH 中的 OpenSSL。运行前先执行 `npm run build:packages`。测试夹具直接构造已部署路由快照，不代表注册、治理、发布全过程验收；本地 JWKS 服务不代表外部 OAuth 登录/用户同意流程。外部提供方与 PostgreSQL 实例验收仍在 open-items 中。
