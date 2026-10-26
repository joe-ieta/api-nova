---
doc-version: 1.0.0
doc-status: active
doc-updated: 2026-09-28
---
# EXT-06 安全加固与 EXT-07 失败候选保旧证据（2026-09-28）

> Document status: Active evidence。加固为产品代码（回环/合成数据验证）；EXT-07 为真实链路限定本机验收。

## 1. EXT-06 两项发现的安全加固（已修复）

### 1.1 运行时受权抓取自身 spec（Finding 1）
- 新增 `RuntimeSpecAccessService`：HMAC-SHA256 授权（域分离密钥派生自管理 JWT 密钥，`api-nova:runtime-spec-access:v1`），载荷 `{v, runtimeAssetId, serverId, exp}`，TTL 默认 900s/上限 3600s；严格格式/大小/常量时间签名校验，失败关闭。
- `ProcessManagerService` 仅在 spawn 受管运行时（有 `runtimeAssetId`）时铸造，放入子进程临时环境 `API_NOVA_RUNTIME_SPEC_ACCESS_TOKEN`（不进 ProcessConfig/ProcessInfo/DB/日志）；server CLI 仅对 `https:` 或回环 `http:` spec URL 以 `x-api-key` 提交。
- `GET /api/openapi/by-runtime-asset/:id` 迁移到专用 `RuntimeSpecAccessController`+Guard：`Bearer` 仍走**原管理 JWT**（管理员行为不变）；否则须为绑定该资产的有效授权——缺失/无效/过期 401、有效的异资产 403、成功写脱敏审计（`openapi.spec_access`），无匿名路径、无宽泛内部旁路。
- **`verify:ext-06` 已移除 token 注入代理并 `EXT_06_VERIFY_OK` 25/25**（真实路径）。范围偏差：`packages/api-nova-server/src/cli/openapi.ts` 约 15 行 header 透传（否则子进程只能 URL 内嵌凭据，会泄漏到 argv/日志）。

### 1.2 `managedMcp.*` 对象配置可达（Finding 2）
- 新增受校验信封 `API_NOVA_MANAGED_MCP_CONFIG`（`{"handoffSources":…,"lifecycleApproval":…}`）：≤64KiB、仅这两个顶层键、限深/节点/字符、拒绝 `__proto__`/`prototype`/`constructor` 与非纯原型；固定错误 `MANAGED_MCP_CONFIG_INVALID`，不回显内容/不落秘密。
- `resolveManagedMcpConfigValue` 被 `ManagedMcpHandoffPreparationService.source()` 与 `createConfigManagedLifecycleApprovalProvider` 使用：注入配置优先，其次环境子树，缺省失败关闭；既有按键 schema 校验仍为门禁。

### 1.3 加固验证
新 specs **5 套/22 项**；servers+security **35 套/236 项**、openapi 5/20、runtime-assets 7/128；API/Server 构建与 type-check 通过；`verify:ext-06`（无 shim）25/25、e1-02c1 6、e1-02c2 10、e1-03（77/77+31）、e1-04 5、c3-03 18 全绿。

## 2. EXT-07 真实失败候选保旧（DONE 限定本机）

- 执行器：`npm run verify:ext-07`（根 `scripts/verify-ext-07.cjs`），**exit 0**，`EXT_07_VERIFY_OK`，**51 gating + 1 informational**（连续两次通过；隔离 API 9013 / MCP 9034 / managed child 9035，隔离 SQLite `E:\temp\opencode\ext-07\api_nova_ext07.db`）
- 场景（真实 HTTP/Gateway + 真实 SDK MCP）：
  - 有效候选先激活并可服务；注入失败候选（上游 500 + 绑定 revision 失效）→ 409 `RUNTIME_VERIFICATION_FAILED`、`activationStatus=retained_previous`；**旧 activeRevision 与持久快照/受管记录不变并继续服务**（上游恢复后无需重部署即恢复 200）；修复后重试同一候选激活并切换 revision
  - MCP：rev1 真实 SDK list/call → 失败候选 409 retained_previous、旧 child 仍应答 → 重试激活 → API 重启后 `/start` + SDK 仍服务同一 revision
- 证据：`E:\temp\opencode\ext-07\evidence\ext-07-evidence.json`、`verify-run.log`、脱敏 `logs\`
- notCovered：外部/非回环、Linux/PG、UI、跨进程并发、生产启用；网关路由为 anonymous+external（候选重放需免消费者凭据；认证消费者访问在 MCP 路径以 DB API key 证明）；runner 保留 loopback spec 代理 shim（产品缺口已按 §1.1 修复并由 `verify:ext-06` 无 shim 独立证明，runner 未改）。
