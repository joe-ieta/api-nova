---
doc-version: 1.0.0
doc-status: active
doc-updated: 2026-09-21
---
# SEC-B1-01 统一消费者凭证模型与双入口验收

起点7d62173，最终代码版本为包含本报告的提交。Windows、Node24.15.0、PostgreSQL16.10；锁文件SHA256 `9eb15cc0265e1366483cc340ee6e7e55638af3ed558eb09dc1a5bb032f3f2a54`。

## 模型和管理入口

沿用gateway_consumer_credentials，新增nullable accessPolicy JSON列保存version=1、subject、protocols、toolScopes、scopes、expiresAt、可信actorId。外层id/keyId/secretHash/status/runtimeAssetId/routeBindingId不得由JSON覆盖。旧NULL行只保留原Gateway语义，不自动取得MCP授权或进入统一导出。
`POST /api/runtime-assets/:id/runtime-access-credentials`创建，`GET`同路径列摘要，`POST .../:credentialId/revoke`撤销，均沿用既有受权管理策略；旧gateway-consumer-credentials路径作为别名保留。新增字段由API/Swagger管理，未新增UI字段表单。Subject缺省为Key ID，Protocols缺省当前资产类型，toolScopes和scopes缺省空，expiresAt缺省30天（Unix秒）；Actor仅来自已鉴权管理上下文。
完整keyId.secret仅创建返回一次；只持久SHA256(secret)，普通列表不返回摘要。`GET /api/runtime-assets/:id/runtime-access-credentials/configuration`要求server:manage，导出version/runtimeAssetId/credentials的摘要配置，不导出完整Key。

## 两入口执行

Gateway和MCP复用Parser verifyRuntimeAccessCredential，对摘要、状态、到期、Protocol、Runtime/Route及共享required scopes同样判定。稳定Subject产生稳定callerId，工具allowlist同时限制tools/list和tools/call：[]无工具、["*"]显式所有，继续与宿主scope要求取交集。
MCP主机明确配置API_NOVA_RUNTIME_ACCESS_CREDENTIALS为导出JSON；存在即优先，损坏/空字符串不能回退旧API_NOVA_RUNTIME_API_KEYS。独立CLI由主机提供envelope；受管Lifecycle/ProcessManager强制它与持久服务Runtime ID相符，启动、实际spawn、重启停旧进程前及等待后复核。ProcessConfig只记Runtime ID，不保存摘要配置；凭证仅进入临时child环境。
当前是显式配置快照，不自动从DB热传播。DB撤销会影响Gateway下一请求；已运行MCP child的更新/撤销及Rotation Family窗口留B1-02，不能用导出成功冒充传播成功。

## 验证

- 主任务API联合Gateway全套、管理、真实模型及进程边界：23套277/277，退出0。
- 真实SQL.js管理→序列化→销毁重开→Gateway HTTP与MCP解释：11/11，包含actor不可伪造、列表无完整Key/摘要、protocol/runtime/expiry、旧NULL不导出、非法策略零写入。
- Parser共享与旧鉴权46/46；Parser/Server/API构建均退出0。
- 主任务真实Streamable/SSE及SDK四种注册入口40/40；工具执行专项20/20（并行执行者）。
- 主任务真实CLI脚本4/4，新增统一envelope进入实际child、缺失/错误Key401、正确Key200，且旧配置无效不影响明确新配置；跨Runtime配置在启动前拒绝。
- SQLite迁移/模型及旧MCP基线、数据库选项3套5/5；主任务连同模型复验4套16/16。新增nullable列不授予旧凭证，down/up不复活已删除策略，完整实体schema漂移0。
- 主任务隔离PG完整验收：69实体/69表、4迁移、空库与重连漂移0、重连迁移0、持久化和真实API启动通过；clusterStopped/clusterRemoved均true。

脚本和源码：[模型集成](../../packages/api-nova-api/src/modules/runtime-assets/services/runtime-access-credential.integration.spec.ts)、[共享验证器](../../packages/api-nova-parser/src/audit/runtime-access-credential.ts)、[CLI真实子进程](../../packages/api-nova-api/scripts/test-mcp-inbound-process-auth.cjs)、[PG隔离验收](../../packages/api-nova-api/scripts/test-isolated-postgres-schema.cjs)。

只关闭B1-01并解锁B1-02/A3-01，不提升B1父包；没有执行生产迁移、对外部署、Linux或生产IPC交付。测试计数存在重叠，不相加作新增功能量。
