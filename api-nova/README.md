# ApiNova

**语言**：中文 | [English](./README_EN.md)

ApiNova（中文名：达雅 / Api达雅），一个面向 AI 时代的 API Gateway 与 API AI能力平台。

ApiNova 自动装载、注册多源Api服务端口，构建统一的Api服务资产，实现Api探测、解析、校验、测试、标准化管理，实现权鉴、访问、缓存、流控、熔断核心功能，在提供Api聚合应用的同时，让传统API能力自然融入AI应用，支持LLM运行时接入，提供API Gateway 与 MCP Server双模一体的管理、服务平台。

English speakers can use [README_EN.md](./README_EN.md).

## 项目来源

ApiNova 起源于 [`mcp-swagger-server`](https://github.com/zaizaizhao/mcp-swagger-server)。

原项目为 OpenAPI / Swagger 解析、MCP Tool 生成与快速运行时暴露提供了重要基础。本仓库在此基础上继续独立演进，当前产品定位不再只是 OpenAPI 到 MCP 的技术展示，而是一个兼顾 API Gateway 管理能力与 AI-ready API capability delivery 的产品化工程。

## 当前项目特性

- 支持从 URL、文件上传、原始文本导入 OpenAPI / Swagger
- 支持规范解析、校验、标准化与兼容性转换
- 支持 Swagger 2.0 到 OpenAPI 3.x 的兼容处理
- 支持将 API 能力转换为 MCP Tools
- 支持 `stdio`、`streamable`、`sse` 三种 MCP 运行时传输方式
- 提供 CLI、API、UI 协同的导入、转换、发布与管理链路
- 提供 Endpoint Registry，用于手工端点注册与轻量治理
- 支持探测、就绪检查、发布、下线等端点生命周期动作
- 支持 Bearer Token 与自定义 Header 注入
- 支持托管进程生命周期、日志、健康检查与监控
- 默认使用 SQLite，同时支持 PostgreSQL
- 当前基线同时覆盖 Windows 与 Linux / Ubuntu

## Monorepo 结构

- `packages/api-nova-parser`
  负责 OpenAPI / Swagger 输入的解析、校验、标准化与兼容处理。
- `packages/api-nova-server`
  负责将标准化后的 API 操作转换为 MCP Tools，并提供 MCP 运行时。
- `packages/api-nova-api`
  负责管理 API、持久化、认证、服务编排与监控支撑。
- `packages/api-nova-ui`
  负责面向运营与管理人员的导入、校验、转换与服务管理界面。

## 当前基线

### 运行要求

- Node.js `>= 20`
- pnpm `>= 8`
- Windows
- Linux，其中当前主要兼容目标为 Ubuntu

### 数据库模式

- 默认：`SQLite`
- 可选：`PostgreSQL`

SQLite 适合单节点与轻量部署。

PostgreSQL 适合更高并发、更长生命周期任务与更重的运维场景。

### 当前支持的 MCP Transport

- `stdio`
- `streamable`
- `sse`

说明：

- 当前基线下，`streamable` 预期支持并发多会话访问
- API / UI 中的 WebSocket 仅用于管理与监控，不属于 MCP transport

## 快速开始

### 作为 CLI / MCP Server 运行

安装：

```bash
npm install -g api-nova-server
```

以 `stdio` 方式启动：

```bash
api-nova --openapi https://petstore.swagger.io/v2/swagger.json --transport stdio
```

MCP 客户端配置示例：

```json
{
  "mcpServers": {
    "swagger-api": {
      "command": "api-nova",
      "args": [
        "--openapi",
        "https://petstore.swagger.io/v2/swagger.json",
        "--transport",
        "stdio"
      ]
    }
  }
}
```

### 本地开发

```bash
node -v
corepack enable
corepack prepare pnpm@latest --activate
pnpm -v
pnpm install
pnpm build
pnpm dev
pnpm test
pnpm lint
pnpm type-check
```

更多说明：

- [Local Setup And Run](./docs/guides/local-setup-and-run.md)
- [Database Mode Quickstart](./docs/guides/database-mode-quickstart.md)
- [Database Strategy](./docs/guides/database-strategy.md)

数据库模式快速检查：

- 未设置 `DB_TYPE` 时，`api-nova-api` 默认使用 `SQLite`
- 设置 `DB_TYPE=postgres` 时，`api-nova-api` 使用 `PostgreSQL`
- 启动日志应显示 `Database mode: sqlite` 或 `Database mode: postgres`

## 默认开发端口

默认开发布局如下：

- UI：`http://127.0.0.1:9000`
- API：`http://127.0.0.1:9001`
- MCP Streamable 示例：`http://127.0.0.1:9022/mcp`

说明：

- `/mcp` 是 MCP 协议端点，不是浏览器页面
- 浏览器直接访问 `/mcp` 时若返回 `Mcp-Session-Id header is required`，属于符合预期的协议行为

## Current Product Boundary

- OpenAPI Management remains the batch import and specification processing entry.
- Manual endpoint registration remains a separate construction method under API Registration.
- API Testing is the functional gate before Governance.
- API Governance is the readiness decision surface.
- API Publication is the first normal surface where MCP Server and Gateway runtime identities are created.
- Runtime Assets and Monitoring are downstream operation surfaces.

## Documentation Entry

Start from:

- [PRODUCT_CONSTRAINTS](./PRODUCT_CONSTRAINTS.md)
- [PROJECT_BASELINE](./PROJECT_BASELINE.md)
- [RELEASE_BASELINE_V1](./RELEASE_BASELINE_V1.md)
- [Documentation Index](./docs/README.md)
- [Next Development Baseline](./NEXT_DEVELOPMENT_BASELINE.md)
- [Staged Development Plan](./docs/guides/staged-development-plan.md)
- [Open Items](./docs/reference/open-items.md)

## 工作原则

- 在扩展范围之前，优先稳定发布路径
- 对延期项保持可见，不将其表述为已完成能力
- 保持 Windows 与 Linux / Ubuntu 支持一致
- 保持文档、CLI、API、UI 与真实实现一致
- 优先保证长期运行可靠性，而不是单纯追求功能数量

## 许可证

MIT，详见 [LICENSE](./LICENSE)
