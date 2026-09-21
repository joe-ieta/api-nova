---
doc-version: 1.0.0
doc-status: active
doc-updated: 2026-09-21
---
# SEC-A1-02D 保存、发布、重启与真实请求闭环

代码起点：`c0ff1a8`；最终代码版本为包含本报告的提交。Windows、Node24.15.0，锁文件SHA256 `9eb15cc0265e1366483cc340ee6e7e55638af3ed558eb09dc1a5bb032f3f2a54`。所有数据库、进程和回环服务为隔离夹具，结束后关闭清理。

## Gateway

[执行脚本](../../packages/api-nova-api/scripts/test-gateway-auth-persistence-lifecycle.cjs)真实SQL.js磁盘保存三模式路由/成员/凭证/上游绑定/样例→关闭重开→真实RuntimeVerification与GatewayCandidateReplay进行3次HTTP上游回放→激活持久快照→真实GatewayRuntime HTTP。
每模式缺失/错误/正确凭证，共9项；随后把工作路由未发布改为anonymous并设置冲突环境默认，关闭重开数据库及服务、从已激活快照恢复，再跑9项。两轮正确保留JWT/API Key/anonymous语义，拒绝请求未访问上游。

## MCP与stdio

[MCP脚本](../../packages/api-nova-api/scripts/test-mcp-auth-persistence-lifecycle.cjs)及[发布夹具](../../packages/api-nova-api/scripts/mcp-auth-publication-fixture.cjs)执行真实RuntimeAssets.deployMcpRuntimeAsset、规范组装、候选plan/replay/activate。每模式先上游500：不写server/activeRevision；200成功后再次500：保留旧激活版本。
使用该实际发布配置关闭重开磁盘数据库，真实Lifecycle/ProcessManager/CLI两次启动，验证缺失/错误/正确凭证；每次真实tools/call恰好产生一次回环上游调用。3模式、6次child启动。配置标签正确，管理effective保持unknown；未伪造在线模式回执。
真实stdio审计脚本12/12重跑，覆盖local_process、协议stdout、真实工具和取消/崩溃边界；stdio不套HTTP鉴权。

## 实际修复

- ProcessManager直接spawn Node并隐藏窗口，修复Windows路径含空格时shell将可执行文件拆开的启动失败。含空格argv专项回归。
- 规范组装对空displayName省略可选description，修复description:null被真实Validator拒绝；真实发布夹具保留空来源名。

## 主任务复验命令与结果

- `npm run build --workspace=api-nova-api`：退出0。
- `node packages/api-nova-api/scripts/test-gateway-auth-persistence-lifecycle.cjs`：18项真实HTTP、3候选回放、2次DB重开，退出0。
- `node packages/api-nova-api/scripts/test-mcp-auth-persistence-lifecycle.cjs`：3/3，6次实际child，退出0。
- `node packages/api-nova-server/scripts/test-mcp-stdio-observability.cjs`：12/12，退出0。
- API相关Jest：并行执行者4套64/64；主任务ProcessManager、环境映射、RuntimeAssets3套48/48重验，退出0。两组重叠，不累加为新增用例。

## 退出与限制

SEC-A1-02D完成；结合既有模式UI和入口拒绝证据，逐条复核原TP-A1模式收敛及旧OAuth策略不迁移条件后，A1父包DONE。不是凭子任务数量提升父包。
Gateway配置通过真实Repository保存，核心编译/验证/激活/代理均真实；MCP规范由隔离HTTP提供实际发布后的OpenAPI。日志/指标存储使用有限适配。没有额外验收管理HTTP规范下载权限、浏览器端到端、Linux、生产IPC生命周期或生产部署；这些不作为该模式闭环的虚假证据。
