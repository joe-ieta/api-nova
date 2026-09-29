---
doc-version: 1.1.0
doc-status: active
doc-updated: 2026-09-28
---
# EXT-08 / EXT-06 Windows 本机验收证据（2026-09-28）

> Document status: Active evidence。Windows 本机、回环与隔离库；不含浏览器点击/截图与生产启用。

## 1. EXT-08 Windows完整交互启动（DONE 限定本机）

- 执行器：`npm run verify:ext-08`（根 `scripts/verify-ext-08.cjs`），**exit 0**，`EXT_08_VERIFY_OK`，**26/26 gating + 1 informational**
- 环境：API 9011 + UI 5181（Vite 代理 /api→9011），隔离 SQLite `E:\temp\opencode\ext-08\api_nova_ext08.db`（先 migration+seed），commit `113b342`，Windows 10.0.19045，Node v24.15.0
- 链路证据（全程 loopback、无外网、无密钥输出）：
  - API `/api/health/ready`=ready（full `/health` 503 为宿主磁盘阈值+idle mcp_server，信息项）；SPA 10/11 路由 200（`/monitoring` 因既有 Vite 代理规则 404，信息项）
  - 超管真实登录 → OpenAPI 上传（endpoints=1/tools=1）与 URL 导入 → 文档转换 201（endpointCount=1）
  - 治理：实例 probe healthy → 端点 probe verified/publishEnabled → 功能测试 passed → smoke 样本 → readiness 全真 → 候选 ready
  - 发布：runtime asset 201 → membership 201 → 上游绑定 rev1 → profile reviewed → publish 201（active、publishedToMcp=true、rev1）→ 状态复读 active
  - 激活：preview 201 → `deploy-mcp` **201** 验证 passed、candidateRevision 一致、managedServerId 记录、asset `activeRevision` 匹配
- 证据：`E:\temp\opencode\ext-08\evidence\ext-08-evidence.json`、`verify-run.log`、`logs\*`、原始 `audit\*.jsonl`
- notCovered：浏览器点击/截图、生产 UI 构建、外部系统/Linux/PG；受管 child 启动与真实 MCP 会话归 EXT-06。

## 2. EXT-06 真实MCP消费者（DONE 限定本机）

- 执行器：`npm run verify:ext-06`（根 `scripts/verify-ext-06.cjs`），**exit 0**，`EXT_06_VERIFY_OK`，**25/25 checks**（独立复跑 3 次）
- 环境：API 9012（隔离 SQLite `E:\temp\opencode\ext-06\api_nova_ext06.db`）、真实 SDK `@modelcontextprotocol/sdk` 1.29.0 客户端
- 覆盖：
  - Streamable `http://127.0.0.1:9032/ext06/mcp`（真实发布+候选验证+真实 child `api-nova-server/dist/cli.js`）与 SSE `/ext06/sse`（/messages）：list `ping` + 真实工具调用命中 loopback 上游
  - 受信 `trusted_ipc_v1`：`dist/managed/entry.js`（真实 IPC、READY、干净 STOPPED、PID 释放）
  - 凭据/会话：缺/错/过期 key 401 `invalid_api_key`；gateway-only 凭据用于 MCP 403 `credential_scope_forbidden`（铸造亦被 400 拒绝）；`toolScopes:[]` 空列表+调用拒绝；跨主体会话 403 而属主不受影响；撤销后活动会话与重连 401，另一主体正常
  - 秘密扫描：凭据值不出现在上游/DB/API 日志/process-info/process-logs/凭据列表/配置导出；child argv/env 无凭据；受管上游只收到其 registry bearer
- 发现（建议后续项，不在本批修）：
  1. 产品内部 spec 回调 `/api/openapi/by-runtime-asset/:id` 受管理 JWT 保护，而 spawn 的运行时需要抓取 spec；验收以 loopback 注入 token 的代理绕过（产品未改）。建议评估运行时可用的受权 spec 获取方式。
  2. 受信生命周期读取 `managedMcp.handoffSources/lifecycleApproval` 为对象，经 Nest `ConfigService` 从纯环境变量只能得到字符串；对象仅在注入配置（如 E1-04 规格）下可达，API 侧受管部署路径依赖 fixture 通道。建议产品化配置来源。
- 证据：`E:\temp\opencode\ext-06\evidence.json`（脱敏机读记录）、runner SHA256 `373B1DFC…`；notCovered：外部网络/接收端、Linux 变体、生产启用。
- **后续（2026-09-28 已修复）**：两项发现已产品化修复——运行时受权 spec 获取（`RuntimeSpecAccessService`+专用 Guard；`verify:ext-06` 已无 shim 通过）与 `API_NOVA_MANAGED_MCP_CONFIG` 受校验信封；详见[加固证据](./2026-09-28-ext-06-hardening-and-ext-07.md)。
