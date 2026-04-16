# ApiNova

**语言**：中文 | [English](./README_EN.md)

ApiNova（中文名：达雅，亦可称 Api达雅）是一个面向 AI 时代的 API Gateway 与 API 能力平台。

本项目为一个轻量化API网关，同时提供MCP Server自动发布，方便传统服务（API）被 AI 应用、Agent 与模型运行时接入、理解与调用，可与qt-llmlite项目配合。

For english users please read [README_EN.md](./README_EN.md)。

## 项目起源

ApiNova 起源于 `mcp-swagger-server`。

随着产品定位与实现基线持续变化，本仓库已经不再只是 OpenAPI 到 MCP 的技术展示，希望API对现代AI支持与传统API Gateway能力并重，构建一个轻量化的基础应用平台，支撑传统数据服务，简化AI从大量现有API服务中获得能力的过程，提供API语义表达，实现AI应用的“信达雅”。

项目原始来源于 `mcp-swagger-server`，为 OpenAPI / Swagger 解析、MCP Tool 生成与快速运行时暴露提供了很好的基础设计，是0到1的突破，真诚感谢原作者与贡献者的工作，并欢迎继续为本项目提出指导、改进和建议。

当前仓库作为独立产品线继续演进，原项目仍将是本项目的重要参考来源，但不再是 ApiNova 的控制性产品基线。

## 当前项目特性

- 支持从 URL、文件上传、原始文本导入 OpenAPI / Swagger
- 支持规范解析、校验、标准化与兼容转换
- 支持生成 MCP Tools，并将 API 整理为更适合 AI 使用的能力形态
- 支持 `stdio`、`streamable`、`sse` 三种 MCP 运行时交付方式
- 提供 CLI、API、UI 三层协同的网关管理工作流
- 提供 Endpoint Registry，用于手工注册端点以及探测、就绪检查、发布、下线等动作
- 支持 Bearer Token 与自定义 Header 注入
- 支持托管进程生命周期、日志、健康检查与监控
- 默认使用 SQLite，也支持 PostgreSQL 作为更重型的部署路径
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

PostgreSQL 适合更高并发、更长生命周期任务与更强运维要求的部署场景。

### 当前支持的 MCP 传输

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

详见：

- [Local Setup And Run](./docs/guides/local-setup-and-run.md)
- [Database Mode Quickstart](./docs/guides/database-mode-quickstart.md)
- [Database Strategy](./docs/guides/database-strategy.md)

数据库模式快速检查：

- 未设置 `DB_TYPE` 时，`api-nova-api` 默认使用 `SQLite`
- 设置 `DB_TYPE=postgres` 时，`api-nova-api` 使用 `PostgreSQL`
- 启动日志会打印 `Database mode: sqlite` 或 `Database mode: postgres`
- 当前基线已验证：
  - SQLite 默认启动路径
  - PostgreSQL 模式下的 schema 初始化与启动路径
  - 两种数据库模式下的 CI / 测试覆盖

## 默认开发端点

默认开发布局下：

- UI：`http://127.0.0.1:9000`
- API：`http://127.0.0.1:9001`
- MCP Streamable 示例：`http://127.0.0.1:9022/mcp`

说明：

- `/mcp` 是 MCP 协议端点，不是浏览器页面
- 浏览器直接访问 `/mcp` 时，如果收到 `Mcp-Session-Id header is required`，这是符合协议预期的行为

## 当前产品能力

- OpenAPI / Swagger 导入
- URL 导入、原始文本导入、文件上传导入
- 规范校验与标准化
- Swagger 2.0 到 OpenAPI 3.x 兼容转换
- OpenAPI `3.0.4` 兼容处理
- Tool 预览与转换工作流
- 通过 Endpoint Registry 进行手工端点注册
- 手工端点的探测、就绪检查、发布、下线生命周期动作
- Bearer Token 与自定义 Header 注入
- `streamable` 多会话支持
- CLI 与 Server smoke test 覆盖
- 托管进程生命周期与进程日志查看
- SQLite / PostgreSQL 双数据库支持

当前运营边界说明：

- OpenAPI Management 仍然是导入与规范处理主路径
- Endpoint Registry 是与之并行的管理面，用于手工注册端点以及对导入端点进行轻量治理
- 规划中的语义层增强仍处于延期状态，当前作为开放事项持续跟踪

## 文档入口

建议从以下文档开始：

- [PRODUCT_CONSTRAINTS](./PRODUCT_CONSTRAINTS.md)
- [PROJECT_BASELINE](./PROJECT_BASELINE.md)
- [RELEASE_BASELINE_V1](./RELEASE_BASELINE_V1.md)
- [Documentation Index](./docs/README.md)
- [Fork Origin And Independence](./docs/guides/fork-origin-and-independence.md)
- [Current Convergence Plan](./docs/guides/current-convergence-plan.md)
- [Open Items](./docs/reference/open-items.md)

## 工作原则

- 在扩展范围之前，优先稳定发布路径
- 对延期项保持可见，不将其表述为已完成能力
- 保持 Windows 与 Linux / Ubuntu 支持一致
- 保持文档、CLI、API、UI 与真实实现一致
- 优先保证长周期运行可靠性，而不是单纯追求功能数量

## 许可证

MIT，详见 [LICENSE](./LICENSE)
