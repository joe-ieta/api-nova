# ApiNova

**Languages**: [中文](./README.md) | English

ApiNova (Chinese name: Daya, also referred to as ApiDaya in Chinese contexts) is an API Gateway and API capability platform for the AI era.

The project is a lightweight API gateway that also provides MCP Server publishing, so that traditional services and APIs can be connected to, understood by, and invoked from AI applications, agents, and model runtimes more easily.

The Chinese README is the default project introduction. This file is the English companion version.

## Project Origin

ApiNova originates from `mcp-swagger-server` / `https://github.com/zaizaizhao/mcp-swagger-server`.

As the product positioning and implementation baseline evolved, this repository stopped being only a technical OpenAPI-to-MCP demonstration. The current direction is to balance modern AI-facing API capability delivery with traditional API gateway value, forming a lightweight application platform that helps existing API services expose usable capabilities to AI systems with better semantic expression.

The original `mcp-swagger-server` project provided an important 0-to-1 foundation for OpenAPI / Swagger parsing, MCP tool generation, and fast runtime exposure. The project remains an important reference source, but it is no longer the controlling product baseline for ApiNova.

## Current Project Features

- Import OpenAPI / Swagger from URL, file upload, or raw content
- Parse, validate, normalize, and compatibility-convert API specifications
- Generate MCP tools and reshape APIs into AI-ready capabilities
- Support three MCP runtime transport modes: `stdio`, `streamable`, and `sse`
- Provide coordinated gateway management workflows across CLI, API, and UI
- Provide an Endpoint Registry for manual endpoint registration plus probe, readiness check, publish, and offline lifecycle actions
- Support Bearer Token and custom header injection
- Support managed process lifecycle, logs, health checking, and monitoring
- Use SQLite by default, with PostgreSQL as the heavier deployment option
- Keep both Windows and Linux / Ubuntu in the supported baseline

## Monorepo Structure

- `packages/api-nova-parser`
  Responsible for parsing, validation, normalization, and compatibility handling of OpenAPI / Swagger inputs.
- `packages/api-nova-server`
  Responsible for transforming normalized API operations into MCP tools and providing the MCP runtime.
- `packages/api-nova-api`
  Responsible for management APIs, persistence, authentication, service orchestration, and monitoring support.
- `packages/api-nova-ui`
  Responsible for the operator-facing import, validation, conversion, and service-management interface.

## Current Baseline

### Runtime Requirements

- Node.js `>= 20`
- pnpm `>= 8`
- Windows
- Linux, with Ubuntu as the primary compatibility target

### Database Modes

- Default: `SQLite`
- Optional: `PostgreSQL`

SQLite is suited for single-node and lightweight deployment.

PostgreSQL is suited for higher concurrency, longer-lived tasks, and more demanding operational environments.

### Currently Supported MCP Transports

- `stdio`
- `streamable`
- `sse`

Notes:

- Under the current baseline, `streamable` is expected to support concurrent multi-session access.
- WebSocket support in the API / UI is for management and monitoring only. It is not an MCP transport.

## Quick Start

### Run as a CLI / MCP Server

Install:

```bash
npm install -g api-nova-server
```

Start in `stdio` mode:

```bash
api-nova --openapi https://petstore.swagger.io/v2/swagger.json --transport stdio
```

Example MCP client configuration:

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

### Local Development

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

See also:

- [Local Setup And Run](./docs/guides/local-setup-and-run.md)
- [Database Mode Quickstart](./docs/guides/database-mode-quickstart.md)
- [Database Strategy](./docs/guides/database-strategy.md)

Quick database mode checks:

- When `DB_TYPE` is not set, `api-nova-api` uses `SQLite` by default
- When `DB_TYPE=postgres` is set, `api-nova-api` uses `PostgreSQL`
- Startup logs should show either `Database mode: sqlite` or `Database mode: postgres`
- The current baseline has already been verified for:
  - SQLite default startup path
  - PostgreSQL schema initialization and startup path
  - CI / test coverage across both database modes

## Default Development Endpoints

Under the default development layout:

- UI: `http://127.0.0.1:9000`
- API: `http://127.0.0.1:9001`
- MCP Streamable example: `http://127.0.0.1:9022/mcp`

Notes:

- `/mcp` is an MCP protocol endpoint, not a browser page
- If a browser directly accesses `/mcp` and receives `Mcp-Session-Id header is required`, that is expected protocol behavior

## Current Product Capabilities

- OpenAPI / Swagger import
- URL import, raw text import, and file upload import
- Spec validation and normalization
- Swagger 2.0 to OpenAPI 3.x compatibility conversion
- OpenAPI `3.0.4` compatibility handling
- Tool preview and conversion workflows
- Manual endpoint registration through Endpoint Registry
- Manual endpoint lifecycle actions including probe, readiness, publish, and offline
- Bearer Token and custom header injection
- `streamable` multi-session support
- CLI and server smoke-test coverage
- Managed process lifecycle and process log inspection
- Dual database support for SQLite and PostgreSQL

Current operating-scope notes:

- OpenAPI Management remains the primary path for import and spec processing
- Endpoint Registry is a parallel management surface for manual endpoint registration and lightweight governance of imported endpoints
- The planned semantic enhancement layer is still deferred and remains an open item rather than released baseline behavior

## Documentation Entry Points

Recommended starting points:

- [PRODUCT_CONSTRAINTS](./PRODUCT_CONSTRAINTS.md)
- [PROJECT_BASELINE](./PROJECT_BASELINE.md)
- [RELEASE_BASELINE_V1](./RELEASE_BASELINE_V1.md)
- [Documentation Index](./docs/README.md)
- [Fork Origin And Independence](./docs/guides/fork-origin-and-independence.md)
- [Current Convergence Plan](./docs/guides/current-convergence-plan.md)
- [Open Items](./docs/reference/open-items.md)

## Working Principles

- Stabilize the release path before expanding scope
- Keep deferred items visible instead of describing them as complete capabilities
- Keep Windows and Linux / Ubuntu support aligned
- Keep docs, CLI, API, and UI aligned with real implementation behavior
- Prioritize long-running operational reliability over raw feature count

## License

MIT. See [LICENSE](./LICENSE).
