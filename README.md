# ApiNova

ApiNova（中文名：达雅，亦可称 Api达雅）是一个面向 AI 时代的 API Gateway 与 API 能力平台。

It preserves core API gateway and API operations capabilities while making managed APIs easier for AI applications, agents, and model runtimes to connect to, understand, and invoke.

Documentation priority is accuracy over localization. Active docs may remain primarily in English during convergence.

## Project Origin

ApiNova started from the original `mcp-swagger-server` project.

The original upstream provided an excellent initial design for OpenAPI/Swagger parsing, MCP tool generation, and fast MCP server exposure. This repository explicitly acknowledges that foundation and thanks the original author and contributors for that work.

This repository has since evolved in a materially different direction. The current goal is no longer only fast OpenAPI-to-MCP conversion as a technical showcase. ApiNova is now being developed as a product-oriented API Gateway and API capability platform, with MCP support treated as one important capability rather than the only product identity.

Because the product positioning and implementation baseline have diverged substantially, this repository now continues as an independent line of development. The original upstream remains a reference source, but it is no longer the controlling baseline for ApiNova.

## Current Project Features

- OpenAPI / Swagger import from URL, file upload, and raw content
- specification parsing, validation, normalization, and compatibility conversion
- MCP tool generation and AI-ready API capability shaping
- MCP runtime delivery over `stdio`, `streamable`, and `sse`
- gateway-oriented management workflows across CLI, API, and UI
- Endpoint Registry for manual registration, probing, readiness, publish, and offline actions
- Bearer token and custom header injection
- managed process lifecycle, logs, health checks, and monitoring support
- SQLite default mode with PostgreSQL as the heavier optional deployment path
- Windows and Linux / Ubuntu support targets in the current baseline

## Monorepo Structure

- `packages/api-nova-parser`
  Parses, validates, normalizes, and reconciles OpenAPI / Swagger inputs.
- `packages/api-nova-server`
  Transforms normalized API operations into MCP tools and provides the MCP runtime.
- `packages/api-nova-api`
  Provides management APIs, persistence, authentication, server orchestration, and monitoring support.
- `packages/api-nova-ui`
  Provides the operator-facing import, validation, conversion, and server management UI.

## Current Baseline

### Runtime requirements

- Node.js `>= 20`
- pnpm `>= 8`
- Windows
- Linux, with Ubuntu treated as the primary Linux compatibility target

### Database modes

- default: `SQLite`
- optional: `PostgreSQL`

SQLite is the default path for single-node and lightweight deployments.

PostgreSQL remains the heavier deployment path for higher concurrency, longer-running operations, and stronger operational requirements.

### Supported MCP transports

Current baseline transports:

- `stdio`
- `streamable`
- `sse`

Notes:

- `streamable` is expected to support concurrent multi-session access in the current baseline
- API/UI websocket channels are used for management and monitoring, but they are not MCP transports

## Quick Start

### Run as a CLI / MCP server

Install:

```bash
npm install -g api-nova-server
```

Start with `stdio`:

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

### Local development

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

See:

- [Local Setup And Run](./docs/guides/local-setup-and-run.md)
- [Database Mode Quickstart](./docs/guides/database-mode-quickstart.md)
- [Database Strategy](./docs/guides/database-strategy.md)

Database mode quick check:

- if `DB_TYPE` is omitted, `api-nova-api` defaults to `SQLite`
- if `DB_TYPE=postgres`, `api-nova-api` runs in `PostgreSQL` mode
- startup logs print `Database mode: sqlite` or `Database mode: postgres`
- the current baseline has already verified:
  - SQLite default startup path
  - PostgreSQL schema initialization and startup path
  - CI coverage for both database modes

## Main Runtime Endpoints

In the default development layout:

- UI: `http://127.0.0.1:9000`
- API: `http://127.0.0.1:9001`
- MCP streamable example: `http://127.0.0.1:9022/mcp`

Notes:

- `/mcp` is an MCP protocol endpoint, not a browser UI page
- if a browser hits `/mcp` directly and receives `Mcp-Session-Id header is required`, that is expected protocol behavior

## Current Product Capabilities

- OpenAPI / Swagger import
- URL import, raw text import, and file upload import
- specification validation and normalization
- Swagger 2.0 to OpenAPI 3.x compatibility conversion
- OpenAPI `3.0.4` compatibility handling in the validation path
- tool preview and conversion workflows
- manual endpoint registration through Endpoint Registry
- endpoint probe, readiness, publish, and offline lifecycle actions for manual endpoints
- Bearer token and custom header injection
- streamable multi-session support
- CLI and server smoke test coverage
- managed process lifecycle and process log inspection
- SQLite / PostgreSQL dual database support

Current operator boundary note:

- OpenAPI Management remains the import and specification workflow
- Endpoint Registry is a peer management surface for manually registered endpoints and lightweight governance of imported endpoints
- the semantic-layer enhancement discussed in planning is still deferred and tracked as an open item

## Documentation Entry Points

Start from:

- [PRODUCT_CONSTRAINTS](./PRODUCT_CONSTRAINTS.md)
- [PROJECT_BASELINE](./PROJECT_BASELINE.md)
- [RELEASE_BASELINE_V1](./RELEASE_BASELINE_V1.md)
- [Documentation Index](./docs/README.md)
- [Fork Origin And Independence](./docs/guides/fork-origin-and-independence.md)
- [Current Convergence Plan](./docs/guides/current-convergence-plan.md)
- [Open Items](./docs/reference/open-items.md)

## Working Rules

- stabilize the release path before expanding scope
- keep deferred items visible instead of implying they already work
- keep Windows and Linux / Ubuntu support aligned
- keep docs, CLI, API, and UI aligned with the real implementation
- prefer reliability of long-running operation over feature count

## License

MIT, see [LICENSE](./LICENSE)
