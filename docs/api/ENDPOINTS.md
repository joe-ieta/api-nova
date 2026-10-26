---
doc-version: 1.0.0
doc-status: active
doc-updated: 2026-10-26
---
# 管理API接口清单

由 `node scripts/export-api-docs.cjs` 从已构建控制器及DTO生成。先阅读[接入手册](./README.md)；字段见[OpenAPI快照](./openapi.json)。禁止手工编辑本表。

共 227 个路径、267 个HTTP操作。快照覆盖Swagger可见的控制器，不包含动态Gateway转发、独立MCP监听及Socket.IO消息。

“公开”仅表示显式Public元数据；“控制器/服务校验”不表示匿名可用。权限列为RequirePermissions元数据，仍需角色、资源范围及服务检查；动态授权见接入手册。

| 方法 | 路径 | 用途 | 入口/声明权限 |
| --- | --- | --- | --- |
| GET | `/` | Application welcome | 控制器/服务校验 |
| GET | `/api/ai-assistant/configs` | 获取AI助手配置列表 | 控制器/服务校验 |
| POST | `/api/ai-assistant/configs` | 生成AI助手配置 | 控制器/服务校验 |
| DELETE | `/api/ai-assistant/configs/{id}` | 删除AI助手配置 | 控制器/服务校验 |
| GET | `/api/ai-assistant/configs/{id}` | 根据ID获取AI助手配置 | 控制器/服务校验 |
| PUT | `/api/ai-assistant/configs/{id}` | 更新AI助手配置 | 控制器/服务校验 |
| POST | `/api/ai-assistant/configs/{id}/export` | 导出AI助手配置 | 控制器/服务校验 |
| PATCH | `/api/ai-assistant/configs/{id}/favorite` | 切换配置收藏状态 | 控制器/服务校验 |
| GET | `/api/ai-assistant/configs/{id}/preview` | 预览AI助手配置 | 控制器/服务校验 |
| POST | `/api/ai-assistant/configs/batch` | 批量操作配置 | 控制器/服务校验 |
| GET | `/api/ai-assistant/configs/stats/overview` | 获取配置统计信息 | 控制器/服务校验 |
| GET | `/api/ai-assistant/health` | AI助手服务健康检查 | 控制器/服务校验 |
| GET | `/api/ai-assistant/info` | 获取AI助手服务信息 | 控制器/服务校验 |
| GET | `/api/ai-assistant/templates` | 获取AI助手模板列表 | 控制器/服务校验 |
| POST | `/api/ai-assistant/templates` | 创建AI助手模板 | 控制器/服务校验 |
| DELETE | `/api/ai-assistant/templates/{id}` | 删除AI助手模板 | 控制器/服务校验 |
| GET | `/api/ai-assistant/templates/{id}` | 根据ID获取AI助手模板 | 控制器/服务校验 |
| PUT | `/api/ai-assistant/templates/{id}` | 更新AI助手模板 | 控制器/服务校验 |
| PATCH | `/api/ai-assistant/templates/{id}/rating` | 为模板评分 | 控制器/服务校验 |
| GET | `/api/ai-assistant/templates/defaults/list` | 获取默认模板 | 控制器/服务校验 |
| GET | `/api/ai-assistant/templates/popular/list` | 获取热门模板 | 控制器/服务校验 |
| GET | `/api/ai-assistant/templates/stats/overview` | 获取模板统计信息 | 控制器/服务校验 |
| DELETE | `/api/audit/cleanup` | 清理过期审计日志 | audit:delete, system:manage |
| GET | `/api/audit/export` | 导出审计日志 | audit:export |
| GET | `/api/audit/logs` | 查询审计日志 | audit:read |
| GET | `/api/audit/logs/{id}` | 获取审计日志详情 | audit:read |
| GET | `/api/audit/search` | 搜索审计日志 | audit:read |
| GET | `/api/audit/security/events` | 获取安全事件 | audit:read, security:monitor |
| GET | `/api/audit/security/failed-logins` | 获取失败登录记录 | audit:read, security:monitor |
| GET | `/api/audit/security/privilege-escalations` | 获取权限提升记录 | audit:read, security:monitor |
| GET | `/api/audit/security/sensitive-data-access` | 获取敏感数据访问记录 | audit:read, security:monitor |
| GET | `/api/audit/security/suspicious-logins` | 获取可疑登录记录 | audit:read, security:monitor |
| GET | `/api/audit/stats/overview` | 获取审计统计概览 | audit:read, system:monitor |
| GET | `/api/audit/timeline/{userId}` | 获取用户操作时间线 | audit:read |
| GET | `/api/audit/user/{userId}/activity` | 获取用户活动统计 | audit:read |
| GET | `/api/auth/check-permission` | 检查用户权限 | 控制器/服务校验 |
| GET | `/api/auth/check-role` | 检查用户角色 | 控制器/服务校验 |
| POST | `/api/auth/forgot-password` | 忘记密码 | 公开 |
| POST | `/api/auth/login` | 用户登录 | 公开 |
| POST | `/api/auth/logout` | 用户登出 | 控制器/服务校验 |
| GET | `/api/auth/me` | 获取当前用户信息 | 控制器/服务校验 |
| POST | `/api/auth/refresh` | 刷新访问令牌 | 公开 |
| POST | `/api/auth/register` | 用户注册 | 公开 |
| POST | `/api/auth/resend-verification` | 重新发送邮箱验证邮件（通用响应） | 公开 |
| POST | `/api/auth/reset-password` | 使用一次性令牌重置密码 | 公开 |
| POST | `/api/auth/verify-email` | 验证邮箱（body token 为主，query 形式已废弃） | 公开 |
| GET | `/api/documents` | 获取用户文档列表 | 控制器/服务校验 |
| POST | `/api/documents` | 创建OpenAPI文档 | 控制器/服务校验 |
| DELETE | `/api/documents/{id}` | 删除文档 | 控制器/服务校验 |
| GET | `/api/documents/{id}` | 获取单个文档详情 | 控制器/服务校验 |
| PATCH | `/api/documents/{id}` | 更新文档 | 控制器/服务校验 |
| GET | `/api/health/info` | Application information | 公开 |
| GET | `/api/health/live` | Liveness check | 公开 |
| GET | `/api/health/ready` | Readiness check | 公开 |
| GET | `/api/monitoring/observability/callers` | List authenticated callers observed in an authorized call snapshot | 控制器/服务校验 |
| GET | `/api/monitoring/observability/callers/{id}` | Read caller profile and scoped retained observations | 控制器/服务校验 |
| PATCH | `/api/monitoring/observability/callers/{id}` | Update a fully authorized caller profile and management audit atomically | 控制器/服务校验 |
| GET | `/api/monitoring/observability/capabilities` | Describe implemented, scope-eligible observability APIs without inventing health or historical coverage | 控制器/服务校验 |
| GET | `/api/monitoring/observability/deliveries` | List authorized durable webhook deliveries | 控制器/服务校验 |
| GET | `/api/monitoring/observability/deliveries/{id}` | Read a delivery and bounded redacted attempt history | 控制器/服务校验 |
| POST | `/api/monitoring/observability/deliveries/{id}/retry` | Idempotently requeue an eligible retained delivery | 控制器/服务校验 |
| GET | `/api/monitoring/observability/dependencies` | Observed upstream dependencies and deduplicated visible external business impact; configured unused dependencies are not included. | 控制器/服务校验 |
| GET | `/api/monitoring/observability/events` | Read authorized durable events in commit sequence order | 控制器/服务校验 |
| GET | `/api/monitoring/observability/invocations` | List authorized invocation metadata at a stable snapshot | 控制器/服务校验 |
| GET | `/api/monitoring/observability/invocations/{id}` | Read the latest authorized invocation metadata | 控制器/服务校验 |
| GET | `/api/monitoring/observability/invocations/{id}/payloads/{side}` | Read an authorized request or response body with mandatory management audit | 控制器/服务校验 |
| GET | `/api/monitoring/observability/overview` | Authorized business/upstream snapshot and persisted server state; pipeline and recentEvents are unavailable. | 控制器/服务校验 |
| GET | `/api/monitoring/observability/pipeline/status` | Read persisted pipeline evidence; monitoring:read with explicit global resource scope required | 控制器/服务校验 |
| GET | `/api/monitoring/observability/policies` | Read the effective global policy for new observability events and payloads | 控制器/服务校验 |
| PATCH | `/api/monitoring/observability/policies/{id}` | Atomically update new-event and payload retention with audit; global management scope required | 控制器/服务校验 |
| GET | `/api/monitoring/observability/servers/status` | Persisted authorized asset lifecycle and historical reports; live health, heartbeat and stateVersion remain unknown. | 控制器/服务校验 |
| GET | `/api/monitoring/observability/sources` | List daily access-source observations, with separately authorized IP fields | 控制器/服务校验 |
| GET | `/api/monitoring/observability/statistics/groups` | Rank one or two whitelisted dimensions without summing distinct counts across groups | 控制器/服务校验 |
| GET | `/api/monitoring/observability/statistics/summary` | Summarize up to 5000 authorized retained invocations without fabricating historical coverage or liveness | 控制器/服务校验 |
| GET | `/api/monitoring/observability/statistics/time-series` | Return UTC-aligned on-demand buckets from one authorized retained-invocation snapshot | 控制器/服务校验 |
| GET | `/api/monitoring/observability/subscriptions` | List authorized webhook subscriptions from a fixed snapshot | 控制器/服务校验 |
| POST | `/api/monitoring/observability/subscriptions` | Create a versioned webhook subscription without sending network traffic | 控制器/服务校验 |
| DELETE | `/api/monitoring/observability/subscriptions/{id}` | Soft-delete a subscription and cancel unfinished deliveries atomically | 控制器/服务校验 |
| GET | `/api/monitoring/observability/subscriptions/{id}` | Read an authorized subscription without exposing signing secrets | 控制器/服务校验 |
| PATCH | `/api/monitoring/observability/subscriptions/{id}` | Create a new effective subscription revision atomically | 控制器/服务校验 |
| POST | `/api/monitoring/observability/subscriptions/{id}/test` | Queue one explicit test event without synchronous network traffic | 控制器/服务校验 |
| GET | `/api/monitoring/observability/traces/{traceId}` | Read up to 200 retained, authorized trace nodes without silent truncation | 控制器/服务校验 |
| GET | `/api/openapi/by-runtime-asset/{runtimeAssetId}` | Get assembled OpenAPI document by runtime asset ID | 控制器/服务校验 |
| GET | `/api/openapi/by-server/{serverId}` | Get OpenAPI document by server ID | 控制器/服务校验 |
| POST | `/api/openapi/normalize` | Normalize OpenAPI/Swagger specification | 控制器/服务校验 |
| POST | `/api/openapi/parse` | Parse OpenAPI/Swagger specification | 控制器/服务校验 |
| GET | `/api/openapi/parse-url` | Parse OpenAPI/Swagger specification from URL | 控制器/服务校验 |
| POST | `/api/openapi/upload` | Upload and parse OpenAPI/Swagger specification file | 控制器/服务校验 |
| POST | `/api/openapi/validate` | Validate OpenAPI/Swagger specification | 控制器/服务校验 |
| POST | `/api/openapi/validate-upload` | Upload and validate OpenAPI/Swagger specification file | 控制器/服务校验 |
| GET | `/api/openapi/validate-url` | Validate OpenAPI/Swagger specification from URL | 控制器/服务校验 |
| GET | `/api/permissions` | 查询权限列表 | permission:read |
| POST | `/api/permissions` | 创建权限 | permission:create |
| DELETE | `/api/permissions/{id}` | 删除权限 | permission:delete |
| GET | `/api/permissions/{id}` | 获取权限详情 | permission:read |
| PUT | `/api/permissions/{id}` | 更新权限信息 | permission:update |
| GET | `/api/permissions/{id}/roles` | 获取拥有该权限的角色列表 | permission:read, role:read |
| PUT | `/api/permissions/{id}/toggle` | 切换权限启用状态 | permission:update |
| GET | `/api/permissions/actions` | 获取操作类型列表 | permission:read |
| POST | `/api/permissions/batch` | 批量创建权限 | permission:create |
| GET | `/api/permissions/categories` | 获取权限类别列表 | permission:read |
| GET | `/api/permissions/system/init` | 初始化系统权限 | system:manage |
| GET | `/api/permissions/tree/structure` | 获取权限树形结构 | permission:read |
| GET | `/api/roles` | 查询角色列表 | role:read |
| POST | `/api/roles` | 创建角色 | role:create |
| DELETE | `/api/roles/{id}` | 删除角色 | role:delete |
| GET | `/api/roles/{id}` | 获取角色详情 | role:read |
| PUT | `/api/roles/{id}` | 更新角色信息 | role:update |
| POST | `/api/roles/{id}/copy` | 复制角色 | role:create |
| GET | `/api/roles/{id}/permissions` | 获取角色权限列表 | role:read, permission:read |
| POST | `/api/roles/{id}/permissions` | 为角色分配权限 | role:update, permission:assign |
| DELETE | `/api/roles/{id}/permissions/{permissionId}` | 移除角色权限 | role:update, permission:assign |
| PUT | `/api/roles/{id}/toggle` | 切换角色启用状态 | role:update |
| GET | `/api/roles/{id}/users` | 获取角色下的用户列表 | role:read, user:read |
| GET | `/api/roles/system/init` | 初始化系统角色 | system:manage |
| POST | `/api/security/upstream-credentials/reload` | Reload the configured credential file with generation precondition | config:update |
| GET | `/api/security/upstream-credentials/status` | Read process-local credential registry metadata | config:read |
| GET | `/api/system/health` | 获取系统健康状态 | 公开 |
| GET | `/api/system/initialization` | 获取系统初始化状态 | 公开 |
| GET | `/api/system/initialized` | 检查系统是否已初始化 | 公开 |
| GET | `/api/users` | 查询用户列表 | user:read |
| POST | `/api/users` | 创建用户 | user:create |
| DELETE | `/api/users/{id}` | 删除用户 | user:delete |
| GET | `/api/users/{id}` | 获取用户详情 | user:read |
| PUT | `/api/users/{id}` | 更新用户信息 | user:update |
| GET | `/api/users/{id}/activity` | 获取用户活动记录 | user:read, audit:read |
| PUT | `/api/users/{id}/lock` | 锁定用户账户 | user:update |
| PUT | `/api/users/{id}/password` | 修改用户密码 | user:update |
| POST | `/api/users/{id}/reset-password` | 重置用户密码 | user:update |
| PUT | `/api/users/{id}/roles` | 分配用户角色 | user:update, role:assign |
| DELETE | `/api/users/{id}/sessions` | 终止用户所有会话 | user:update |
| GET | `/api/users/{id}/sessions` | 获取用户会话信息 | user:read |
| PUT | `/api/users/{id}/unlock` | 解锁用户账户 | user:update |
| GET | `/api/v1/assets/endpoints` | List endpoint definitions | server:read |
| GET | `/api/v1/assets/endpoints/{id}` | Get endpoint definition detail | server:read |
| PATCH | `/api/v1/assets/endpoints/{id}/governance` | Update endpoint definition governance | server:update |
| DELETE | `/api/v1/assets/endpoints/{id}/manual` | Delete manual endpoint asset | server:manage |
| PATCH | `/api/v1/assets/endpoints/{id}/manual` | Update manual endpoint asset | server:update |
| POST | `/api/v1/assets/endpoints/{id}/probe` | Probe endpoint definition | server:update |
| GET | `/api/v1/assets/endpoints/{id}/readiness` | Get endpoint definition readiness | server:read |
| POST | `/api/v1/assets/endpoints/{id}/test` | Execute endpoint definition functional test | server:update |
| GET | `/api/v1/assets/endpoints/{id}/testing-state` | Get endpoint definition testing state | server:read |
| POST | `/api/v1/assets/endpoints/manual` | Register manual endpoint asset | server:manage |
| GET | `/api/v1/assets/source-services` | List source service assets | server:read |
| GET | `/api/v1/assets/source-services/{id}` | Get source service asset detail | server:read |
| GET | `/api/v1/assets/source-services/{sourceServiceAssetId}/instances` | List runtime instances owned by one source service asset | server:read |
| POST | `/api/v1/assets/source-services/{sourceServiceAssetId}/instances` | Create a runtime instance for one source service asset | server:manage |
| GET | `/api/v1/assets/source-services/{sourceServiceAssetId}/instances/{instanceId}` | Get one source service runtime instance | server:read |
| PATCH | `/api/v1/assets/source-services/{sourceServiceAssetId}/instances/{instanceId}` | Update one source service runtime instance | server:manage |
| POST | `/api/v1/assets/source-services/{sourceServiceAssetId}/instances/{instanceId}/archive` | Archive one source service runtime instance | server:manage |
| POST | `/api/v1/assets/source-services/{sourceServiceAssetId}/instances/{instanceId}/probe` | Probe one source service runtime instance | server:manage |
| POST | `/api/v1/assets/source-services/{sourceServiceAssetId}/instances/{instanceId}/set-default` | Set the environment default runtime instance | server:manage |
| GET | `/api/v1/config` | Get application configuration | 控制器/服务校验 |
| PATCH | `/api/v1/config` | Update runtime-tunable configuration | 控制器/服务校验 |
| GET | `/api/v1/config/backups` | List configuration backups | 控制器/服务校验 |
| PATCH | `/api/v1/config/backups` | Create a configuration backup | 控制器/服务校验 |
| DELETE | `/api/v1/config/backups/{id}` | Delete a configuration backup | 控制器/服务校验 |
| PATCH | `/api/v1/config/backups/{id}/restore` | Restore a configuration backup | 控制器/服务校验 |
| GET | `/api/v1/config/environment` | Get environment information | 控制器/服务校验 |
| GET | `/api/v1/config/export` | Export current configuration overrides | 控制器/服务校验 |
| PATCH | `/api/v1/config/import` | Import configuration overrides | 控制器/服务校验 |
| PATCH | `/api/v1/config/import/preview` | Preview configuration import conflicts | 控制器/服务校验 |
| GET | `/api/v1/endpoint-testing/endpoints/{endpointDefinitionId}/test-cases` | List endpoint test cases | server:read |
| POST | `/api/v1/endpoint-testing/endpoints/{endpointDefinitionId}/test-cases` | Create endpoint test case | server:update |
| GET | `/api/v1/endpoint-testing/endpoints/{endpointDefinitionId}/test-runs` | List endpoint test runs | server:read |
| GET | `/api/v1/endpoint-testing/endpoints/{endpointDefinitionId}/test-samples` | List automatically captured endpoint test samples | server:read |
| DELETE | `/api/v1/endpoint-testing/test-cases/{testCaseId}` | Delete endpoint test case | server:manage |
| PATCH | `/api/v1/endpoint-testing/test-cases/{testCaseId}` | Update endpoint test case | server:update |
| DELETE | `/api/v1/endpoint-testing/test-samples/{sampleId}` | Delete an ordinary sample or revoke a binary sample pending object removal | server:manage |
| PATCH | `/api/v1/endpoint-testing/test-samples/{sampleId}` | Maintain an automatically captured test sample | server:update |
| POST | `/api/v1/endpoint-testing/test-samples/{sampleId}/archive` | Archive an endpoint test sample | server:update |
| GET | `/api/v1/endpoint-testing/test-samples/{sampleId}/binary-content` | Download a stored binary response sample | server:manage |
| POST | `/api/v1/endpoint-testing/test-samples/binary-objects/cleanup` | Explicitly reclaim revoked and abandoned staged binary objects in a bounded pass | server:manage |
| POST | `/api/v1/endpoint-testing/test-samples/cleanup` | Delete ordinary expired samples and mark binary objects pending removal | server:manage |
| GET | `/api/v1/monitoring/events` | Get recent runtime events | monitoring:read |
| GET | `/api/v1/monitoring/events/errors` | Get recent error events | monitoring:read |
| GET | `/api/v1/monitoring/health` | Get monitoring health status | monitoring:read |
| GET | `/api/v1/monitoring/management/audit` | Query management audit stream | audit:read |
| GET | `/api/v1/monitoring/management/events` | Query management events | monitoring:read |
| GET | `/api/v1/monitoring/management/gateway-access-logs` | Query gateway access logs | monitoring:read |
| GET | `/api/v1/monitoring/management/overview` | Get management observability overview | monitoring:read |
| GET | `/api/v1/monitoring/metrics` | Get monitoring metrics | monitoring:read |
| GET | `/api/v1/publication/endpoints/audit-events` | List publication audit events | audit:read |
| GET | `/api/v1/publication/endpoints/batch-runs` | List publication batch runs | audit:read |
| GET | `/api/v1/publication/endpoints/candidates` | List publication candidates from governance-ready endpoint catalog | server:read |
| POST | `/api/v1/publication/endpoints/runtime-assets` | Create one publication runtime asset draft | server:manage |
| POST | `/api/v1/publication/endpoints/runtime-assets/{runtimeAssetId}/memberships` | Add ready endpoints into one publication runtime asset | server:manage |
| GET | `/api/v1/publication/endpoints/runtime-memberships` | List publication runtime memberships | server:read |
| GET | `/api/v1/publication/endpoints/runtime-memberships/{membershipId}` | Get runtime membership publication state | server:read |
| PUT | `/api/v1/publication/endpoints/runtime-memberships/{membershipId}/gateway-route` | Configure runtime membership gateway route binding | server:update |
| POST | `/api/v1/publication/endpoints/runtime-memberships/{membershipId}/offline` | Take one runtime membership offline | server:manage |
| PUT | `/api/v1/publication/endpoints/runtime-memberships/{membershipId}/profile` | Upsert runtime membership publication profile | server:update |
| POST | `/api/v1/publication/endpoints/runtime-memberships/{membershipId}/publish` | Publish one runtime membership | server:manage |
| POST | `/api/v1/publication/endpoints/runtime-memberships/batch/offline` | Batch offline runtime memberships | server:manage |
| POST | `/api/v1/publication/endpoints/runtime-memberships/batch/publish` | Batch publish runtime memberships | server:manage |
| GET | `/api/v1/runtime-assets` | List runtime assets | server:read |
| DELETE | `/api/v1/runtime-assets/{id}` | Delete runtime asset and its derived deployment records | server:delete, server:manage |
| GET | `/api/v1/runtime-assets/{id}` | Get runtime asset detail | server:read |
| GET | `/api/v1/runtime-assets/{id}/access-logs` | List gateway access logs for one runtime asset | monitoring:read |
| POST | `/api/v1/runtime-assets/{id}/deploy-gateway` | Assemble and deploy one gateway runtime asset into active gateway config | server:manage |
| POST | `/api/v1/runtime-assets/{id}/deploy-mcp` | Deploy MCP runtime asset into one managed server record | server:manage |
| GET | `/api/v1/runtime-assets/{id}/gateway-assembly` | Assemble gateway payload for one runtime asset | server:read |
| GET | `/api/v1/runtime-assets/{id}/gateway-consumer-credentials` | List gateway consumer credentials for one runtime asset | server:read |
| POST | `/api/v1/runtime-assets/{id}/gateway-consumer-credentials` | Create one gateway consumer credential scoped to this runtime asset | server:manage |
| POST | `/api/v1/runtime-assets/{id}/gateway-consumer-credentials/{credentialId}/revoke` | Revoke one gateway consumer credential | server:manage |
| GET | `/api/v1/runtime-assets/{id}/mcp-assembly` | Assemble MCP payload for one runtime asset | server:read |
| POST | `/api/v1/runtime-assets/{id}/mcp-endpoint-preview` | Preview managed MCP endpoint without allocation or deployment | server:manage |
| GET | `/api/v1/runtime-assets/{id}/memberships` | List runtime asset memberships | server:read |
| GET | `/api/v1/runtime-assets/{id}/observability` | Get runtime asset observability summary | monitoring:read |
| PUT | `/api/v1/runtime-assets/{id}/policy-binding` | Update top-level runtime asset policy binding reference | server:manage |
| POST | `/api/v1/runtime-assets/{id}/redeploy` | Re-assemble and redeploy one MCP runtime asset | server:manage |
| GET | `/api/v1/runtime-assets/{id}/runtime-access-credentials` | List gateway consumer credentials for one runtime asset | server:read |
| POST | `/api/v1/runtime-assets/{id}/runtime-access-credentials` | Create one gateway consumer credential scoped to this runtime asset | server:manage |
| POST | `/api/v1/runtime-assets/{id}/runtime-access-credentials/{credentialId}/revoke` | Revoke one gateway consumer credential | server:manage |
| POST | `/api/v1/runtime-assets/{id}/runtime-access-credentials/{credentialId}/rotate` | RuntimeCredentialRotationController_rotate | server:manage |
| GET | `/api/v1/runtime-assets/{id}/runtime-access-credentials/configuration` | Export a versioned runtime credential digest snapshot | server:manage |
| POST | `/api/v1/runtime-assets/{id}/start` | Start managed MCP server bound to this runtime asset | server:manage |
| POST | `/api/v1/runtime-assets/{id}/stop` | Stop managed MCP server bound to this runtime asset | server:manage |
| GET | `/api/v1/runtime-assets/{runtimeAssetId}/verification-runs` | List runtime deployment verification runs | server:read |
| GET | `/api/v1/runtime-assets/{runtimeAssetId}/verification-runs/{verificationRunId}` | Get runtime deployment verification evidence | server:read |
| POST | `/api/v1/runtime-assets/{runtimeAssetId}/verification-runs/{verificationRunId}/execute-gateway` | Replay a planned Gateway candidate and activate it only on success | server:manage |
| POST | `/api/v1/runtime-assets/{runtimeAssetId}/verification-runs/plan` | Build and persist a candidate deployment verification plan | server:manage |
| DELETE | `/api/v1/runtime-memberships/{runtimeMembershipId}/upstream-binding` | Delete a runtime membership upstream binding | server:manage |
| GET | `/api/v1/runtime-memberships/{runtimeMembershipId}/upstream-binding` | Get the upstream binding for a runtime membership | server:read |
| PUT | `/api/v1/runtime-memberships/{runtimeMembershipId}/upstream-binding` | Create or replace a runtime membership upstream binding | server:manage |
| GET | `/api/v1/runtime-memberships/{runtimeMembershipId}/upstream-binding/resolution` | Resolve the deterministic healthy upstream candidate | server:read |
| GET | `/api/v1/servers` | List servers | server:read |
| POST | `/api/v1/servers` | Create server | server:create, server:manage |
| DELETE | `/api/v1/servers/{id}` | Delete server | server:delete, server:manage |
| GET | `/api/v1/servers/{id}` | Get server | server:read |
| PUT | `/api/v1/servers/{id}` | Update server | server:update, server:manage |
| POST | `/api/v1/servers/{id}/actions` | Run server action | server:execute, server:manage |
| GET | `/api/v1/servers/{id}/health` | Get server health | monitoring:read |
| POST | `/api/v1/servers/{id}/health/check` | Run health check | server:execute, server:manage |
| GET | `/api/v1/servers/{id}/health/history` | Get health history | monitoring:read |
| GET | `/api/v1/servers/{id}/mcp/connections/stats` | Get server MCP connection stats | monitoring:read |
| GET | `/api/v1/servers/{id}/metrics` | Get server metrics | monitoring:read |
| GET | `/api/v1/servers/{id}/metrics/summary` | Get server metric summary | monitoring:read |
| GET | `/api/v1/servers/{id}/process` | Get process info | monitoring:read |
| POST | `/api/v1/servers/{id}/process/cancel-restart` | Cancel process restart | server:manage |
| GET | `/api/v1/servers/{id}/process/errors/stats` | Get process error stats | monitoring:read |
| GET | `/api/v1/servers/{id}/process/full-info` | Get process full info | monitoring:read |
| GET | `/api/v1/servers/{id}/process/health/history` | Get process health history | monitoring:read |
| GET | `/api/v1/servers/{id}/process/health/stats` | Get process health stats | monitoring:read |
| GET | `/api/v1/servers/{id}/process/logs` | Get process logs | monitoring:read |
| POST | `/api/v1/servers/{id}/process/logs/clear` | Clear log buffer | server:manage, monitoring:manage |
| GET | `/api/v1/servers/{id}/process/logs/history` | Get process log history | monitoring:read |
| POST | `/api/v1/servers/{id}/process/logs/monitor/start` | Start log monitoring | server:manage, monitoring:manage |
| POST | `/api/v1/servers/{id}/process/logs/monitor/stop` | Stop log monitoring | server:manage, monitoring:manage |
| GET | `/api/v1/servers/{id}/process/logs/search` | Search process logs | monitoring:read |
| POST | `/api/v1/servers/{id}/process/reset-restart-counter` | Reset restart counter | server:manage |
| GET | `/api/v1/servers/{id}/process/resources` | Get process resources | monitoring:read |
| GET | `/api/v1/servers/{id}/process/resources/history` | Get process resource history | monitoring:read |
| POST | `/api/v1/servers/{id}/process/resources/monitor/start` | Start resource monitoring | server:manage, monitoring:manage |
| POST | `/api/v1/servers/{id}/process/resources/monitor/stop` | Stop resource monitoring | server:manage, monitoring:manage |
| GET | `/api/v1/servers/{id}/system-logs` | Get server system logs | monitoring:read |
| GET | `/api/v1/servers/{id}/system-logs/latest` | Get latest server system logs | monitoring:read |
| GET | `/api/v1/servers/{id}/tools` | Get server tools | server:read |
| POST | `/api/v1/servers/batch/actions` | Run batch server action | server:execute, server:manage |
| GET | `/api/v1/servers/debug/states` | Get debug server states | system:view |
| GET | `/api/v1/servers/health/overview` | Get health overview | monitoring:read |
| GET | `/api/v1/servers/mcp/connections/stats` | Get all MCP connection stats | monitoring:read |
| GET | `/api/v1/servers/metrics/system` | Get system metrics | monitoring:read |
| GET | `/api/v1/servers/system-logs` | Query system logs | monitoring:read |
| GET | `/api/v1/servers/system/resources` | Get system resources | monitoring:read |
| GET | `/favicon.ico` | Favicon | 控制器/服务校验 |
| GET | `/health` | Application health check | 公开 |
