# ApiNova Runtime

`api-nova-server` 是 ApiNova 的运行时核心包，负责将 OpenAPI 操作转换为 MCP Tools，并启动 MCP 运行时服务。

它提供：

- OpenAPI 操作到 MCP Tool 的转换
- CLI 启动入口
- `stdio` / `streamable` / `sse` 运行模式
- 面向 AI 应用与 MCP 客户端的直接接入能力

## 当前定位

该包是整个仓库中最接近可直接发布和运行的核心运行时包。

当前推荐命令：

- `api-nova`

兼容命令别名：

- `api-nova-server`
- `api-nova-interactive`

## 当前支持基线

### OpenAPI / Swagger

- OpenAPI 3.x
- Swagger 2.0
- JSON / YAML
- URL / 本地文件输入

### MCP 传输

当前明确支持：

- `stdio`
- `streamable`
- `sse`

说明：

- `streamable` 在当前发布基线中支持并发多会话访问
- WebSocket 只作为 API / UI 管理与监控层的实时通道，不属于本包的 MCP transport 基线

## 快速使用

### 直接运行

```bash
api-nova --openapi https://petstore.swagger.io/v2/swagger.json --transport stdio
```

### Streamable HTTP

HTTP 模式默认校验外部 OAuth/JWT，启动前需配置受信任 issuer、JWKS 和资源 URL。仅本机匿名测试需显式设置 `API_NOVA_RUNTIME_AUTH_MODE=anonymous`。完整配置见[安全调用与日志审计](../../docs/guides/runtime-security-and-call-audit.md)。

```bash
api-nova --openapi https://petstore.swagger.io/v2/swagger.json --transport streamable --port 9022
```

### SSE

```bash
api-nova --openapi https://petstore.swagger.io/v2/swagger.json --transport sse --port 9022
```

## 常用参数

下面的 `--auth-type` / `--bearer-*` 是调用上游 API 的凭证；MCP 客户端入站鉴权使用 `API_NOVA_RUNTIME_*` 环境配置。验证成功的外部调用者会自动进入清单，无需预先注册。调用日志默认追加到 `data/runtime-audit`，生产应设置 `API_NOVA_AUDIT_DIR` 为受限、持久化的绝对目录。

```bash
--openapi <url|file>
--transport <stdio|streamable|sse>
--port <number>
--host <string>
--base-url <url>
--config <file>
--env <file>
--auth-type <none|bearer>
--bearer-token <token>
--bearer-env <var>
--watch
```

## 本地开发

```bash
npm run build --workspace api-nova-server
npm run cli:help --workspace api-nova-server
npm run dev --workspace api-nova-server
npm run test --workspace api-nova-server
npm run test:smoke --workspace api-nova-server
npm run test:cli --workspace api-nova-server
npm run test:streamable-session --workspace api-nova-server
npm run test:security-audit --workspace api-nova-server
```

## 与整仓的关系

本包通常有两种使用方式：

1. 直接通过 CLI 或 MCP 客户端调用
2. 由 `api-nova-api` 托管并间接调度运行

## 相关文档

- [Project README](../../README.md)
- [Local Setup And Run](../../docs/guides/local-setup-and-run.md)
- [Runtime Instance And Regression Closure Plan](../../docs/guides/runtime-instance-and-regression-closure-plan.md)
