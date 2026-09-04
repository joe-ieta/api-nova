# ApiNova 配置参数盘点与治理建议

更新时间：2026-04-22

## 1. 结论摘要

当前系统中的“配置”实际分为三层：

1. 启动时环境参数
2. 数据库中的业务配置
3. 前端页面中的本地模拟/硬编码参数

现状不是“没有配置”，而是“配置分散且不透明”：

- 一部分参数已经真实生效，但只存在于环境变量或代码默认值中。
- 一部分参数已存在于数据库字段中，但没有统一抽象为“策略模板”或“系统设置”。
- 当前 UI 的“配置管理”页面主要是原型/模拟实现，不能作为真实配置中心。

## 2. 盘点范围

本次盘点基于以下代码入口：

- 后端统一配置入口：
  - `packages/api-nova-api/src/config/validation.schema.ts`
  - `packages/api-nova-api/src/config/app-config.service.ts`
- 后端配置接口：
  - `packages/api-nova-api/src/modules/config/config.controller.ts`
- 前端配置管理：
  - `packages/api-nova-ui/src/stores/config.ts`
  - `packages/api-nova-ui/src/modules/config/ConfigManager.vue`
  - `packages/api-nova-ui/src/modules/config/ConfigManagerNew.vue`
- 关键运行链路：
  - `packages/api-nova-api/src/app.module.ts`
  - `packages/api-nova-api/src/main.ts`
  - `packages/api-nova-api/src/modules/servers/services/*.ts`
  - `packages/api-nova-api/src/modules/gateway-runtime/services/*.ts`
  - `packages/api-nova-api/src/modules/publication/dto/publication.dto.ts`
  - `packages/api-nova-api/src/modules/runtime-assets/dto/runtime-assets.dto.ts`

## 3. 配置分层现状

### 3.1 环境变量层

这是目前唯一成体系的系统级配置入口，但并不完整。

已纳入统一校验 schema 的配置，位于 `validation.schema.ts`：

- 应用基础：
  - `NODE_ENV`
  - `PORT`
  - `MCP_PORT`
- CORS：
  - `CORS_ORIGINS`
- 数据库：
  - `DB_TYPE`
  - `DB_SQLITE_PATH`
  - `DB_HOST`
  - `DB_PORT`
  - `DB_USERNAME`
  - `DB_PASSWORD`
  - `DB_DATABASE`
  - `DB_LOGGING`
  - `DB_SYNCHRONIZE`
- 安全：
  - `API_KEY`
  - `JWT_SECRET`
- 日志与保留：
  - `LOG_LEVEL`
  - `LOG_FORMAT`
  - `PROCESS_LOG_PERSIST_ENABLED`
  - `PROCESS_LOG_PERSIST_MIN_INTERVAL_MS`
  - `PROCESS_LOG_MAX_MESSAGE_LENGTH`
  - `PROCESS_LOG_RETENTION_DAYS`
  - `SYSTEM_LOG_RETENTION_DAYS`
  - `HEALTH_CHECK_RETENTION_DAYS`
  - `HEALTH_CHECK_PERSIST_INTERVAL_MS`
- 请求与缓存：
  - `REQUEST_TIMEOUT`
  - `CACHE_TTL`
  - `MAX_PAYLOAD_SIZE`
- MCP / OpenAPI：
  - `MCP_SERVER_HOST`
  - `MCP_SERVER_PORT`
  - `MCP_SERVER_HEALTH_CHECK_INTERVAL`
  - `DEFAULT_OPENAPI_BASE_URL`
  - `MAX_OPENAPI_FILE_SIZE`
  - `OPENAPI_CACHE_TTL`
- 监控与开发：
  - `METRICS_ENABLED`
  - `HEALTH_CHECK_ENABLED`
  - `HEALTH_CHECK_TIMEOUT`
  - `HOT_RELOAD`
  - `WATCH_FILES`
  - `DEBUG_MODE`

### 3.2 已使用但未纳入统一 schema 的环境变量

这部分是优先级最高的治理缺口，因为系统真实依赖它们，但没有统一校验、文档和展示。

#### 安全与认证

- `JWT_EXPIRES_IN`
- `JWT_REFRESH_SECRET`

使用位置：

- `packages/api-nova-api/src/modules/security/security.module.ts`
- `packages/api-nova-api/src/modules/security/services/auth.service.ts`

#### 全局 API 限流

- `THROTTLE_TTL`
- `THROTTLE_LIMIT`

使用位置：

- `packages/api-nova-api/src/app.module.ts`

#### 进程管理与托管运行时

- `PROCESS_TIMEOUT`
- `PROCESS_MAX_RETRIES`
- `PROCESS_RESTART_DELAY`
- `HEALTH_CHECK_INTERVAL`
- `PID_DIRECTORY`
- `LOG_DIRECTORY`

使用位置：

- `packages/api-nova-api/src/modules/servers/services/process-manager.service.ts`

#### 健康检查与自动恢复

- `HEALTH_CHECK_HISTORY_MAX_AGE`
- `AUTO_RESTART_UNHEALTHY_SERVERS`

使用位置：

- `packages/api-nova-api/src/modules/servers/services/server-health.service.ts`

#### 运行时调用与内部回调

- `API_BASE_URL`
- `MCP_SERVER_TIMEOUT`

使用位置：

- `packages/api-nova-api/src/modules/servers/services/server-lifecycle.service.ts`

#### 监控历史保留

- `METRICS_HISTORY_MAX_AGE`

使用位置：

- `packages/api-nova-api/src/modules/servers/services/server-metrics.service.ts`

## 4. 数据库中的业务级配置

这部分不是环境变量，而是“运行时业务配置”。它们会直接影响系统行为，应被纳入统一的配置治理视图。

### 4.1 认证配置

实体：

- `packages/api-nova-api/src/database/entities/auth-config.entity.ts`

可配置内容：

- 认证类型：`none` / `bearer` / `apikey` / `basic` / `oauth2`
- Bearer token
- API key/header/query
- Basic 用户名密码
- OAuth2 clientId / clientSecret / tokenUrl / scope
- 自定义 headers / queryParams
- 是否启用
- 过期时间

说明：

- 这类配置是真实业务配置，不应混入“系统设置”。
- 它更适合作为“认证资产/认证模板”管理。

### 4.2 发布与网关路由绑定配置

实体与 DTO：

- `packages/api-nova-api/src/database/entities/gateway-route-binding.entity.ts`
- `packages/api-nova-api/src/modules/publication/dto/publication.dto.ts`

已支持的配置项包括：

- `matchHost`
- `routePath`
- `pathMatchMode`
- `priority`
- `upstreamPath`
- `routeMethod`
- `upstreamMethod`
- `routeVisibility`
- `authPolicyRef`
- `trafficPolicyRef`
- `loggingPolicyRef`
- `cachePolicyRef`
- `rateLimitPolicyRef`
- `circuitBreakerPolicyRef`
- `timeoutMs`
- `retryPolicy`
- `upstreamConfig`
- `routeStatusReason`

说明：

- 这一层已经是实际生效的 API 网关控制面。
- 但目前缺少统一“策略模板中心”，更多是通过字段散落配置。

### 4.3 Runtime Asset 部署配置

DTO：

- `packages/api-nova-api/src/modules/runtime-assets/dto/runtime-assets.dto.ts`

已支持的配置项包括：

- MCP 部署：
  - `targetServerId`
  - `name`
  - `description`
  - `transport`
  - `port`
  - `autoStart`
- Gateway 部署：
  - `policyBindingRef`
  - `publishedOnly`

说明：

- 这些参数已经具备运行期调整价值。
- 目前更多是动作型入参，不是持久化的“统一参数管理项”。

## 5. API 流控与运行控制：实际已支持的能力

这是本次盘点最关键的发现之一：系统已经具备 API 流控能力，但没有统一显式呈现。

类型定义与编译逻辑：

- `packages/api-nova-api/src/modules/gateway-runtime/types/gateway-policy.types.ts`
- `packages/api-nova-api/src/modules/gateway-runtime/services/gateway-policy.service.ts`
- `packages/api-nova-api/src/modules/gateway-runtime/services/gateway-traffic-control.service.ts`

### 5.1 已实现的流控能力

#### 超时控制

- `timeoutMs`

默认值：

- 未配置时默认 `30000`

#### 限流

支持字段：

- `windowMs`
- `globalMax`
- `runtimeAssetMax`
- `routeMax`
- `consumerMax`

效果：

- 可按全局、运行时资产、路由、消费者四个维度拒绝请求

#### 并发控制

支持字段：

- `runtimeAssetMax`
- `routeMax`

效果：

- 超并发时拒绝请求

#### 熔断器

支持字段：

- `failureThreshold`
- `cooldownMs`
- `halfOpenMax`

效果：

- `closed / open / half_open` 三态控制

#### 重试策略

支持字段：

- `retryPolicy`

说明：

- 结构已存在，但当前仍偏底层原始对象，缺少统一 schema 和 UI。

#### 缓存

支持字段：

- `ttlMs`
- `varyQueryKeys`
- `varyHeaderKeys`
- `varyByConsumer`
- `maxBodyBytes`

说明：

- 能力存在，但策略命名、默认模板和说明还不完整。

## 6. 前端运行参数

### 6.1 Vite / 前端部署参数

文件：

- `packages/api-nova-ui/vite.config.ts`
- `packages/api-nova-ui/src/env.d.ts`

当前显式变量：

- `VITE_PROXY_TARGET`
- `VITE_APP_TITLE`
- `VITE_API_BASE_URL`
- `VITE_FORCE_MOCK_MODE`

说明：

- 实际生效最明确的是 `VITE_PROXY_TARGET`
- `VITE_API_BASE_URL` 在类型声明中存在，但当前 API service 仍主要使用相对路径 `/api`

### 6.2 前端硬编码的运行参数

#### API 请求

文件：

- `packages/api-nova-ui/src/services/api.ts`
- `packages/api-nova-ui/src/services/mcpApi.ts`

硬编码：

- Axios timeout：`30000`

#### WebSocket

文件：

- `packages/api-nova-ui/src/services/websocket.ts`

硬编码：

- `maxReconnectAttempts = 5`
- 连接超时 `20000`
- 订阅刷新间隔 `5000`
- 心跳机制启用，但心跳间隔未抽成统一参数

说明：

- 这些都是适合参数化的前端运行设置。
- 当前没有统一配置入口，也没有环境变量映射。

## 7. 配置管理页面的真实状态

### 7.1 后端只提供只读配置接口

文件：

- `packages/api-nova-api/src/modules/config/config.controller.ts`

当前仅有：

- `GET /v1/config`
- `GET /v1/config/environment`

说明：

- 这是只读查看接口，不支持写入、导入、导出、校验、重启。

### 7.2 前端配置管理页主要是 mock / 原型实现

文件：

- `packages/api-nova-ui/src/stores/config.ts`
- `packages/api-nova-ui/src/modules/config/ConfigManager.vue`
- `packages/api-nova-ui/src/modules/config/ConfigManagerNew.vue`

特征：

- 大量 `generateMockConfig`
- 大量 `setTimeout` 模拟异步
- `getConfigData` 返回的是本地假数据
- `restartServices` 是前端模拟成功提示
- 导入导出逻辑主要在本地完成

### 7.3 前端调用的配置接口与后端不对齐

前端调用：

- `POST /config/export`
- `POST /config/import`
- `POST /config/validate`

后端不存在对应真实实现。

结论：

- 当前“配置管理”页面不是系统控制面
- 只能视作原型页面，不能承担真实配置变更职责

## 8. 建议建立的统一配置模型

建议按四类管理，而不是全部混在一个“配置管理”里：

### 8.1 系统启动参数

适合环境变量 + 只读展示 + 重启生效标记：

- 端口
- 数据库连接
- JWT 密钥与过期策略
- CORS
- 全局限流
- 全局请求体大小
- 监控和健康检查总开关
- 日志级别和保留策略

### 8.2 系统运行参数

适合后台持久化 + 管理页修改：

- 自动重启不健康服务
- 健康检查采样周期
- 健康检查历史保留
- 指标历史保留
- 进程重试/超时策略
- 默认 API timeout
- 前端 WebSocket 重连与心跳参数

### 8.3 业务配置资产

独立模块管理，不应混入系统设置：

- Auth 配置
- OpenAPI 导入规则
- Runtime Asset 部署模板
- AI Assistant 配置

### 8.4 网关策略模板

建议单独建设“策略中心”：

- 超时模板
- 重试模板
- 限流模板
- 并发模板
- 熔断模板
- 缓存模板
- 日志采集模板
- 认证模板

## 9. 优先级建议

### P0：先把真实生效参数纳入统一 schema

优先补入：

- `THROTTLE_TTL`
- `THROTTLE_LIMIT`
- `JWT_EXPIRES_IN`
- `JWT_REFRESH_SECRET`
- `PROCESS_TIMEOUT`
- `PROCESS_MAX_RETRIES`
- `PROCESS_RESTART_DELAY`
- `HEALTH_CHECK_INTERVAL`
- `PID_DIRECTORY`
- `LOG_DIRECTORY`
- `HEALTH_CHECK_HISTORY_MAX_AGE`
- `AUTO_RESTART_UNHEALTHY_SERVERS`
- `METRICS_HISTORY_MAX_AGE`
- `API_BASE_URL`
- `MCP_SERVER_TIMEOUT`

目标：

- 可校验
- 可查看
- 可文档化

### P1：把配置管理页改成真实配置中心

至少应补真实后端接口：

- 读取系统配置
- 校验候选配置
- 保存运行参数
- 查看变更审计
- 标记“需重启生效”

### P1：建立网关策略中心

优先把以下从“散字段”升级为“模板化可选项”：

- Rate limit
- Retry
- Circuit breaker
- Cache
- Logging
- Auth

### P2：统一前端运行参数

建议显式化：

- API timeout
- WebSocket reconnect attempts
- WebSocket connect timeout
- 订阅刷新频率
- 心跳周期

## 10. 推荐下一步工作

建议按以下顺序推进：

1. 建立“全系统配置参数台账”实体文档和字段字典
2. 补齐后端统一 schema，消除隐形参数
3. 把 `/v1/config` 扩展为真实的只读配置总览
4. 下线/重构当前前端 mock 配置管理页面
5. 建立“系统设置”和“策略中心”两类真实配置页

## 11. 本次分析的直接判断

如果只选一个最值得先做的方向，建议是：

**先补后端统一配置治理，再重做前端配置管理页面。**

原因：

- 后端现在已经有大量真实参数
- 前端当前页面不是可信控制面
- 如果不先统一后端参数模型，前端继续扩展只会放大混乱
