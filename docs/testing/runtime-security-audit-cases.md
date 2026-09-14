---
doc-version: 1.2.0
doc-status: active
doc-updated: 2026-09-14
---
# 安全调用与日志审计验收用例

> Document status: Active acceptance baseline
> Last reviewed: 2026-09-14
> Contract: [安全调用与日志审计](../guides/runtime-security-and-call-audit.md)

## 证据时效与当前开发

historical-passed 是 2026-09-06/08 已记录运行，不是本轮复跑或当前全部代码的安全验收。本轮静态对照修正契约：Private Extension 不发布 OAuth Metadata；Discovery 在合法 Host/Origin 下返回 404 / oauth_metadata_not_supported；challenge 不带虚假 resource_metadata。

2026-09-14 授权修正及复验已经完成，最终结果见文末。首次失败记录仅作历史证据，不作为当前阻塞；所有通过结论限于明确运行的专项范围。

## 执行范围

本地 Windows、Node.js、npm 工作区；单元/smoke 使用测试替身与 loopback 服务，多进程联调使用完整 API 入口、独立 MCP 进程、临时 SQLite、HTTPS 代理及远程 JWKS 夹具。所有证书、密钥和日志仅用于本次隔离测试，不依赖生产身份系统或业务数据库。以下本地结果对应本次提交的源代码基线，不代表线上验收。

2026-09-08 清理后复验：Parser 8 套件/30 例、API 45 套件/237 例、Server 6 组冒烟、九阶段回归门禁与七项跨进程安全联调全部通过。真实本地 PG/SQLite 各 43 张业务表通过空库、事务与完整 API 启动冒烟；零数据、零结构差异。详细范围及保留空库位置见 [本轮清理审查记录](../audits/2026-09-08-persistence-cleanup.md)。以下旧计数保留为历史证据。

2026-09-06 执行结果：parser 7 个测试套件、26 个用例通过；联调修复后 API 全量回归 45 个测试套件、199 个用例通过；server 的 CLI、基础运行、多会话、工具转换、安全审计共 5 组 smoke 全部通过；parser/server/API/UI 全量构建和类型检查通过。UI 构建仍提示既有循环 chunk/第三方注释警告，未将其计作测试失败。多进程联调 7 组检查通过，产生 3 次真实上游 API 调用和 4 次 HTTPS JWKS 获取；隔离 SQLite 验证 40 张业务表、零业务行、无待执行迁移，新增配置表通过实体结构零差异检查。生产依赖在线审计被环境策略拦截，状态见 `SEC-DEP-01`，不计作通过。

| 编号 | 验收内容 | 自动化位置 | 状态 |
| --- | --- | --- | --- |
| SEC-01 | 未预登记的有效 JWT 主体可调用；刷新令牌仍为同一 callerId；Gateway/MCP 身份一致 | parser `runtime-security-audit.test.ts` | historical-passed |
| SEC-02 | 错 issuer/audience、过期、未生效、缺失/无签名令牌拒绝；缺 scope 返回 403 | parser 安全测试、server 安全 smoke | historical-passed |
| SEC-03 | 内部 Key 校验完整摘要、有效期和资源；多个 Key 按 subject 归并 | parser 安全测试 | historical-passed |
| SEC-04 | MCP Private Extension challenge 与 OAuth/OIDC Discovery 不支持；不可信 Origin 拒绝、OPTIONS 204 | server `runtime-security-audit-smoke.js` | historical-passed |
| SEC-05 | Streamable POST/GET/DELETE 会话绑定调用者；刷新同主体令牌可继续 | server 安全 smoke | historical-passed |
| SEC-06 | SSE GET/POST 均鉴权，其他主体不能借用消息端点；真实工具调用正常 | server 安全 smoke | historical-passed |
| SEC-07 | 工具 scope 拒绝记录工具参数与拒绝原因，不产生上游调用 | server 安全 smoke | historical-passed |
| SEC-08 | 生产新编译 Gateway 缺省/未知策略不退为匿名；显式匿名/内部 Key 可选择 | API `gateway-policy.service.spec.ts` | historical-passed |
| SEC-09 | 不同已认证主体缓存隔离；入站凭证与上游凭证分离 | API cache、credential、Gateway HTTP 测试 | historical-passed |
| AUD-01 | Gateway 真实 9 KB JSON 请求/响应完整采集，响应摘要正确，请求 ID 贯通 | API `gateway-audit.integration.spec.ts` | historical-passed |
| AUD-02 | MCP 并发及 SSE 工具调用与下游 API 父子关联，9 KB 请求/响应无串线 | server 安全 smoke | historical-passed |
| AUD-03 | JSON、表单、Header、Query、MCP JSON 文本脱敏；已知供应商凭证头也脱敏 | parser 安全测试及 Gateway/server HTTP 测试 | historical-passed |
| AUD-04 | 二进制 Base64、标准 multipart 字段/文件、空正文、超限和损坏 JSON 状态 | parser 安全测试 | historical-passed |
| AUD-05 | 上游超时不伪造 Response；客户端断开记 cancelled/incomplete | API Gateway HTTP 测试 | historical-passed |
| AUD-06 | 准入拒绝记未读取正文；缓存命中保存缓存内容而非虚构上游调用 | API `gateway-access-log.service.spec.ts` | historical-passed |
| AUD-07 | 同调用者观察清单自动归并，JSONL 并发写入可解析；存储故障只输出无正文告警 | parser 安全测试 | historical-passed |
| AUD-08 | MCP 损坏 JSON 返回 400、不回显片段；入站超限 413 | server 安全 smoke | historical-passed |
| REG-01 | 原 CLI、server、工具转换、多会话 smoke 继续通过 | server 全部 smoke | historical-passed |
| REG-02 | parser/server/API/UI 类型检查及构建链路通过 | 根 `verify:parser-chain:full` | historical-passed |
| INT-01 | 完整 API 与独立 MCP 进程经 HTTPS 代理验证前缀、鉴权、Discovery 不暴露、9 KB 调用与调用者归并 | 根 `verify-runtime-security-integration.cjs` | historical-passed |
| INT-02 | 远程 HTTPS JWKS 轮换后两个进程重新取钥，同主体 MCP 会话继续使用 | 同上，包含约 31 秒缓存冷却等待 | historical-passed |
| INT-03 | 管理 API 登录/正文解析保持正常；外部调用令牌不能读取管理调用者清单 | 同上 | historical-passed |
| INT-04 | 禁用自动同步的干净 SQLite baseline 含配置表，完整 API 可启动 | PG/SQLite 初始迁移、统一 `db:smoke` | historical-passed |
| INT-05 | 普通日志跳过 Gateway 流式响应；异常路径脱敏，损坏 URL 不导致二次异常或原文泄漏 | API `logging.interceptor.spec.ts`、`http-exception.filter.spec.ts` | historical-passed |
| EXT-10 | 实际 JWT 签发方、JWKS 轮换、TLS/代理前缀、外部客户端鉴权与长流重连 | [open-items](../reference/open-items.md) | environment-blocked |

## 执行命令

在仓库根目录执行，parser 先构建后测试消费者：

```bash
npm run verify:parser-chain:full
npm run test --workspace api-nova-parser -- --runInBand
npm run test --workspace api-nova-api -- --runInBand
npm run test --workspace api-nova-server
npm run verify:runtime-security-integration
```

server 单项验证入口为 `npm run test:security-audit --workspace api-nova-server`，成功标识为 `RUNTIME_SECURITY_AUDIT_SMOKE_OK`。

多进程联调成功标识为 `RUNTIME_SECURITY_INTEGRATION_OK`。使用临时证书/日志/数据库，结束后只清理本次夹具；不使用开发 `.env` 的业务数据库，不停止用户现有进程。此测试使用预置快照，不替代发布流程和真实外部 JWT/JWKS 提供方验收。系统 `/health` 的 Windows 磁盘探测在受限环境中被拒绝，测试使用 `/api/health/ready` 验证服务就绪，未将完整系统健康检查计作通过。

## 上线前人工检查

1. 确认可信 issuer、JWKS、服务 audience、基础/工具 scope；不同服务是否共享授权边界必须显式决定。
2. 复核已部署 Gateway 快照，需切换策略时重新验证与部署；关闭公网匿名策略。
3. 持久化目录、Windows ACL/Linux 权限、磁盘配额、备份加密和保留周期落实；配置业务敏感字段。
4. 检查 `[RUNTIME_AUDIT_WRITE_FAILED]` 告警可被运维收集；不将当前失败放行实现认定为零丢失审计。
5. 外部环境结果记录日期、提交号、平台、身份提供方、代理配置与证据位置；未运行的项目保持 open。

本次不验收日志分析、时间线展示、报表、QoS 分级、专用审计存储或多主机聚合 UI。

## 2026-09-14 首次专项记录（历史）

> 以下保留首次执行的失败与阻塞，不代表当前结果；授权修正后的最终复验见文末“2026-09-14 授权修正后最终复验”。

| 专项 | 当前结果 |
| --- | --- |
| 管理 JWT 密钥检查与启动 Schema | 41/41 通过；拒绝缺失/短值/固定回退/空白/控制字符，错误不泄密 |
| C1 结构校验 | 测试已编写；TS2322 导致套件未启动 |
| Gateway mode/Header 加固 | 测试已补充；定向 7 套件中 2 通过、5 被相同类型错误阻断 |
| MCP 工具执行授权 | 主注册与库 File/URL/Spec 专项入口已编写，等待 Parser/Server 构建就绪 |
| Parser 全回归 | 12 套件通过、1 套件未启动；119 个已执行用例通过，但整体失败 |
| UI 构建 | 类型检查失败，Vite 未运行 |

新增专项文件与日志统一登记于[执行台账](../guides/security-development-execution-status.md)。历史计数不覆盖上述未执行用例，不能以禁用 TypeScript 检查或旧 dist 绕过验收。

## 2026-09-14 授权修正后最终复验

| 验证范围 | 最终结果 | 验收边界 |
| --- | --- | --- |
| Parser / Server / API / UI | 四项构建通过 | UI 含类型检查和 Vite 构建，不含浏览器自动化 |
| Parser Jest | 13 套，218/218 | 包含 C1 新增 99 项；纯对象校验，不代表凭证加载链路 |
| Gateway / 管理 JWT Jest | 8 套，106/106 | 包含管理 JWT 41 项及新增 mode/Header 专项；不重复计数 |
| MCP 执行前授权 | 20/20 | 注入转换夹具，复用当前身份并重读 scope；不是重新认证/撤销 |
| MCP 既有 HTTP / Transport / HTTP delivery / STDIO | 15 + 15 + 11 + 12 = 53/53 | 保留既有 Windows streamable 大体积边界 |
| MCP smoke | 3 个脚本退出码为 0 | runtime-security-audit、streamable-session、transform-from-spec |
| 跨进程安全集成 | 7/7，3 次上游调用，4 次回环 HTTPS JWKS 读取 | 自有隔离 SQLite 与 API/MCP 测试子进程；包含真实管理登录和完整 v2 终态审计 |
| API 可观测性联合 | 31 文件，547/547，失败/取消/跳过均为 0 | 显式排除真实 PostgreSQL 专项，完整文件清单见最终日志 |

最终关键日志：

- `tmp/security-2026-09-14-parser-tests-rerun-20260914-172608-794.log`
- `tmp/security-2026-09-14-gateway-tests-rerun-173603010.log`
- `tmp/security-2026-09-14-mcp-execution-tests-rerun-172755-087.log`
- `tmp/security-2026-09-14-mcp-tests-rerun-172649-375.log`
- `tmp/security-2026-09-14-integration-v2-rerun-173145.log`
- `tmp/security-2026-09-14-observability-joint-shared-key-20260914-174929-844.log`

本轮修正包含 Parser 类型推断、MCP 只读导出替换、Gateway 入口审计夹具、跨进程 v2 文件/终态读取与刷新、可观测性模块测试 JWT 初始化和共享密钥。全部安全断言保留，不恢复固定密钥、不绕过类型检查。失败日志和修正过程见[安全执行台账](../guides/security-development-execution-status.md)第 9、11 节。

历史日期的通过数量保持原记录；当前 547 项与其它日期或包含文件级失败的 548 项不是同一计数口径。未运行真实 PostgreSQL、真实外部发送、联网依赖审计、跨平台全矩阵、浏览器自动化或生产部署，不据此新增整个安全任务包的 DONE。
