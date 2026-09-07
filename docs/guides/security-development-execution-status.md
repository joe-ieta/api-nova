# ApiNova 安全开发执行与状态记录

> Document status: Active execution ledger
> Last updated: 2026-09-07
> Scope: MCP SDK 1.29.0 的 2025 会话协议；JWT/API Key/显式 Anonymous；OAuth2 保留为后续产品能力，MCP 2026 无状态草案延期

## 状态约定

`BACKLOG` 未满足启动条件；`READY` 可开发；`IN_PROGRESS` 正在实现；`BLOCKED` 被阻断；`REVIEW` 待审核；`DONE` 验收完成；`DEFERRED` 不在当前里程碑。

只有代码、测试、文档和安全证据全部满足时，任务才可标记为 `DONE`。

## 范围冻结

- 保持当前 MCP 2025 Session/Streamable HTTP、SSE 兼容及 stdio 行为；运行时最新协商版本为 2025-11-25。
- MCP 2026 无状态草案/后续正式版本升级和 OAuth2 产品能力均为 `DEFERRED`，不得夹带进当前安全任务；OAuth2 类型与禁用 UI 占位可保留。
- JWT 仅校验预配置 Issuer/JWK/JWKS/Audience/Claims；ApiNova 不获取或签发 Token。
- Gateway/MCP 可分别显式配置 Anonymous；未知、缺失、过期或非法配置不得隐式 Anonymous。

## MCP 协议隔离矩阵

| 传输/协议面 | 当前基线 | 身份与状态边界 | 本轮策略 |
| --- | --- | --- | --- |
| Streamable HTTP | MCP SDK 1.29.0；运行时最新 2025-11-25，兼容 2025-06-18/2025-03-26 等；安全 smoke 当前固定 2025-03-26 | HTTP 请求认证后绑定 `Mcp-Session-Id`；Session 不能替代每请求鉴权 | 保持并加固 |
| SSE | 兼容旧客户端 | 复用同一 MCP Principal/Session 策略，保留独立传输适配 | 保持兼容 |
| stdio | 本地进程通信 | 归类为 `local_process`，不把网络入口认证错误套入 stdio | 保持 |
| MCP 2026 无状态草案/后续正式版本 | SDK 包含 `DRAFT-2026-v1` 类型，但不在运行时 `SUPPORTED_PROTOCOL_VERSIONS` 中 | 需要独立的请求状态、授权与兼容性设计 | DEFERRED |

Gateway HTTP Adapter 与 MCP JSON-RPC/Session Adapter 必须隔离；两者只共享凭证模型、JWT Validator、Upstream Credential Resolver、审计字段与安全策略语义。

## 阶段任务包

| 任务包 | 需求 | 依赖 | 交付与验收 | 状态 |
| --- | --- | --- | --- | --- |
| TP-A0 | SEC-PROTO-01，范围/协议冻结 | 无 | 版本矩阵一致，新协议/OAuth2 延期 | DONE |
| TP-A1 | SEC-A01，认证模式收敛 | TP-A0 | Gateway/MCP 只暴露 JWT/API Key/Anonymous；stdio 为 local process | IN_PROGRESS |
| TP-A2 | SEC-A02，Fail Closed | TP-A1 | 缺失/未知策略拒绝，显式 Anonymous 可用 | IN_PROGRESS |
| TP-A3 | SEC-A03，临时 Anonymous | TP-A2、TP-B1 | reason/expiresAt/actor、到期阻断与审计 | BACKLOG |
| TP-A4 | 开发数据库基线重整 | TP-A0 | PG/SQLite 单一基线、无历史兼容迁移、空库零漂移 | IN_PROGRESS |
| TP-B1 | SEC-B01，Runtime Access Credential | TP-A2 | 通用凭证、协议/Route/Tool Scope、轮换/撤销 | BACKLOG |
| TP-B2 | SEC-B02，JWT Validator | TP-A1 | 固定 JWK/JWKS、issuer/audience/alg/claims | BACKLOG |
| TP-B3 | SEC-B03，MCP Principal/Tool 授权 | TP-B1、TP-B2、TP-E0 | 每请求复验、Session 绑定、Tool 过滤/二次授权 | BACKLOG |
| TP-C1 | SEC-C01，YAML/JSON Schema | TP-A0 | Site 默认、Endpoint 覆盖/None、生产禁明文 | BACKLOG |
| TP-C2 | SEC-C02，Secret Provider | TP-C1 | Env/File Contract 与文件边界防护 | BACKLOG |
| TP-C3 | SEC-C03，Registry/热加载 | TP-C2 | Candidate/Active Snapshot、失败保留旧 Revision | BACKLOG |
| TP-C4 | SEC-C04，继承 Resolver | TP-C3 | None > Endpoint > Site > Unresolved，联网前失败 | BACKLOG |
| TP-D1 | SEC-D01，Gateway Header Policy | TP-C4 | 清除消费者认证头，Resolver 最后注入 | BACKLOG |
| TP-D2 | SEC-D02，Gateway Auth/缓存/限流 | TP-B1、TP-B2、TP-D1 | 身份化缓存、分层限流、Anonymous 独立 Bucket | BACKLOG |
| TP-E0 | MCP 2025 Adapter 边界固化 | TP-A0 | 独立认证/Session/错误契约，不改变协议版本 | BACKLOG |
| TP-E1 | SEC-E01，MCP Upstream Resolver | TP-B3、TP-C4、TP-E0 | Tool→Endpoint ID、共享 Resolver、移除 CLI Secret | BACKLOG |
| TP-E2 | SEC-E02，MCP 协议安全回归 | TP-E1 | SDK/Session/SSE/stdio/取消/重连测试 | BACKLOG |
| TP-F1 | SEC-F01，OpenAPI 对账 | TP-C4 | 四态状态机；OAuth2/OIDC Unsupported；OR/AND 不弱化 | BACKLOG |
| TP-F2 | SEC-F02，控制面/UI | TP-A3、TP-B1、TP-C3、TP-F1 | Consumer/Upstream 分区、匿名风险、脱敏状态 | BACKLOG |
| TP-F3 | SEC-F03，审计/SSRF/泄漏防护 | TP-C4、TP-D1、TP-E1 | 安全事件、重定向/DNS 复核、Secret Scan | BACKLOG |
| TP-F3a | 供应链漏洞治理 | 无，可独立推进 | 生产/开发依赖分层、兼容补丁、重大升级专项验证 | IN_PROGRESS |
| TP-F4 | 全量发布验收 | TP-D2、TP-E2、TP-F1、TP-F2、TP-F3、TP-F3a | Unit/Integration/Regression/Leak/Reload/SSRF/Dependency Audit 全绿 | BACKLOG |
| TP-G1 | OAuth2 产品化能力 | 当前安全基线与独立专项设计 | Provider/Client Registry、Token Store、授权流程、威胁建模与互操作 | DEFERRED |

## 依赖关键路径

```text
TP-A0 -> TP-A1 -> TP-A2 -> TP-B1 -> TP-B3 -> TP-E1 -> TP-E2 --+
                  |          |       ^                          |
                  |          +-> TP-A3 -> TP-F2                 |
                  +-> TP-B2 ----------+                         |

TP-A0 -> TP-C1 -> TP-C2 -> TP-C3 -> TP-C4 -> TP-D1 -> TP-D2 ---+-> TP-F4
                                      |       +-> TP-F3 --------+
                                      +-> TP-E1                 |
                                      +-> TP-F1 -> TP-F2 -------+

TP-F3a ---------------------------------------------------------+

TP-A0 -> TP-E0 -> TP-B3
TP-A0 -> TP-A4
```

- TP-C4 是 Gateway/MCP 上游凭证接入的共同阻塞点；Resolver Contract 稳定后数据面才能并行。
- TP-B1 是临时 Anonymous 元数据、轮换、撤销和 MCP Tool Scope 的共同数据依赖。
- Gateway 与 MCP 共享控制面和 Resolver，不共享 HTTP/JSON-RPC Adapter。
- TP-F3 与数据面回归同为外网生产开放阻断项，不是可选收尾工作。
- TP-F3a 不阻断 Batch 1 功能评审，但阻断“产品安全完成”和外网生产发布。

## 执行批次

| 批次 | 可并行任务 | 退出条件 |
| --- | --- | --- |
| Batch 1 | TP-A0、TP-A1、TP-A2、TP-A4、TP-F3a（独立治理流） | 模式收敛、Fail Closed、显式 Anonymous 回归通过；双库基线与依赖风险已分级 |
| Batch 2 | TP-B1、TP-B2、TP-C1、TP-E0 | 凭证/JWT/Schema/MCP Adapter Contract 稳定 |
| Batch 3 | TP-A3、TP-C2 | 临时 Anonymous 与 Secret Provider 完成 |
| Batch 4 | TP-C3、TP-C4 | Active Snapshot 与 Resolver 完成 |
| Batch 5 | TP-D1、TP-B3、TP-F1 | Header、Tool 授权与发布门禁完成 |
| Batch 6 | TP-D2、TP-E1、TP-F2、TP-F3 | 产品安全能力闭合 |
| Batch 7 | TP-E2、TP-F4 | 全量验收与能力举证完成 |

## 执行记录

| 日期 | 任务包 | 变更/结论 | 验证 | 状态 |
| --- | --- | --- | --- | --- |
| 2026-09-07 | TP-A0 | 冻结 MCP SDK 1.29.0 的 2025-11-25 运行基线及兼容版本；MCP 2026 无状态能力与 OAuth2 延期 | SDK 运行时版本常量、规划/设计/台账交叉检查 | DONE |
| 2026-09-07 | TP-A1 | Runtime Auth 收敛为 jwt/api_key/anonymous；移除 OAuth metadata；Gateway JWT 使用共享 Issuer/Audience/JWK(S) Validator | parser/API/server 类型检查；parser 14 tests；Gateway 41 tests；完整 MCP Server 套件；双运行时集成 | IN_PROGRESS |
| 2026-09-07 | TP-A2 | Gateway 缺失/未知/旧 oauth/runtime-api-key 策略编译失败；显式 anonymous/jwt/api-key 正常；Runtime Auth 未配置失败 | Gateway policy 单测、MCP Anonymous Session smoke、完整 MCP Server 套件、双运行时集成 | IN_PROGRESS |
| 2026-09-07 | TP-A1/A2 调整 | OAuth2 UI 改为禁用的后续能力占位；类型模型保留；当前认证 DTO 拒绝 OAuth2；开发数据库不迁移旧认证快照 | UI build/type-check；DTO 2 tests；发布门禁仍待覆盖全部非法快照 | IN_PROGRESS |
| 2026-09-07 | TP-A4 | 仅保留 PG/SQLite 两个 baseline；删除全部历史增量/后置兼容迁移；默认关闭 synchronize | API build；API 42 suites/195 tests；SQLite 40 表/0 行/0 pending/0 drift；PG 凭证环境阻塞 | IN_PROGRESS |
| 2026-09-07 | TP-F3a | 完成全依赖与生产依赖分层审计；不自动执行可能引入重大版本变更的 `npm audit fix` | 全量：1 Critical/24 High/29 Moderate/3 Low；生产：10 High/21 Moderate | IN_PROGRESS |

每次开发必须追加受影响文件、迁移影响、执行测试、失败项和下一步。测试未执行时不得标记 DONE。

## 供应链风险台账

| 风险项 | 范围 | 当前判定 | 处置要求 |
| --- | --- | --- | --- |
| `@modelcontextprotocol/inspector` | 开发依赖；Critical | 修复建议跨到 2.x，存在兼容性破坏风险 | 隔离开发工具，不随生产包发布；建立 2.x 升级与 MCP 回归任务 |
| Nest/Express/Multer/qs 链 | 生产依赖；High/Moderate | 影响 HTTP 数据面，不能以“间接依赖”降级处理 | 优先尝试兼容补丁；补充请求体、参数与上传边界回归 |
| `fast-uri` / `ip-address` | 生产依赖；High/Moderate | 与 SSRF、Host/IP 判定边界相关 | 与 TP-F3 合并验证 DNS 重绑定、IPv4/IPv6 和重定向复核 |
| `js-yaml` | 生产依赖；Moderate | 将直接处理 TP-C1 动态凭证结构文件 | TP-C1 合入前升级或增加安全解析限制与拒绝型测试 |
| `socket.io-parser`、`nanoid`、`postcss` 等 | 生产/构建链 | 需要按可达性和修复版本逐项确认 | 输出可达性、升级版本、回归结果和接受/豁免记录 |

审计命令：`npm audit --json` 与 `npm audit --omit=dev --json`。依赖审计数字是执行时快照，后续每次锁文件变更和发布候选构建均需刷新。

## Batch 1 评审退出条件

- TP-A1：不迁移存量 `oauth` / `runtime-api-key` 入口策略；开发数据库按新基线重建。UI 可保留禁用的 OAuth2 后续能力占位，但不能提交配置。
- TP-A2：发布/启动门禁必须阻止缺失、未知或非法认证模式进入可调用 Runtime；仅显式 `anonymous` 可放行。
- TP-A3：等待 TP-B1 统一凭证模型后再实现，避免临时 Anonymous 元数据形成第二套状态结构。
- TP-F3a：先完成漏洞可达性与兼容升级清单；未关闭或正式接受的生产依赖风险会阻断 TP-F4。
