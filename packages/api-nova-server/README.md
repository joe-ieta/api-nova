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

```bash
api-nova --openapi https://petstore.swagger.io/v2/swagger.json --transport streamable --port 3322
```

### SSE

```bash
api-nova --openapi https://petstore.swagger.io/v2/swagger.json --transport sse --port 3322
```

## 常用参数

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
pnpm --filter api-nova-server run build
pnpm --filter api-nova-server run cli:help
pnpm --filter api-nova-server run dev
pnpm --filter api-nova-server run test
pnpm --filter api-nova-server run test:smoke
pnpm --filter api-nova-server run test:cli
pnpm --filter api-nova-server run test:streamable-session
```

## 与整仓的关系

本包通常有两种使用方式：

1. 直接通过 CLI 或 MCP 客户端调用
2. 由 `api-nova-api` 托管并间接调度运行

## 相关文档

- [Project README](../../README.md)
- [Local Setup And Run](../../docs/guides/local-setup-and-run.md)
- [Current Convergence Plan](../../docs/guides/current-convergence-plan.md)
