# ApiNova

Convert OpenAPI / Swagger-described REST APIs into runnable MCP tools, managed runtimes, and AI-ready API capabilities.

**Languages**: [中文](./README.md) | English

The default project introduction is now the Chinese README. This file is the English companion version.

## Current Project Features

- OpenAPI / Swagger import from URL, file upload, and raw content
- parsing, validation, normalization, and compatibility conversion
- MCP tool generation and AI-ready API capability delivery
- MCP runtime support for `stdio`, `streamable`, and `sse`
- management workflows across CLI, API, and UI
- Endpoint Registry for manual registration and endpoint lifecycle actions
- Bearer token and custom header injection
- managed process lifecycle, health checks, logs, and monitoring support
- SQLite default mode with PostgreSQL as an optional heavier deployment path
- Windows and Linux / Ubuntu support targets

## Monorepo Structure

- `packages/api-nova-parser`
  OpenAPI/Swagger parsing, validation, normalization, endpoint extraction
- `packages/api-nova-server`
  MCP tool transformation and runtime with `stdio`, `sse`, and `streamable`
- `packages/api-nova-api`
  management backend for orchestration, persistence, security, and operations
- `packages/api-nova-ui`
  operator UI consuming backend contracts

## Recommended Current Usage

### 1. Connect directly as an MCP server for AI applications

Install:

```bash
npm install -g api-nova-server
```

Run in `stdio` mode:

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

### 2. Local development

Requirements:

- Node.js `>= 20`
- pnpm `>= 8`
- GitHub CLI (`gh`, optional for CLI-based PR/release workflow)

Bootstrap development environment:

Windows PowerShell:

```powershell
node -v
corepack enable
corepack prepare pnpm@latest --activate
pnpm -v
```

Ubuntu:

```bash
node -v
corepack enable
corepack prepare pnpm@latest --activate
pnpm -v
```

If `corepack` is unavailable, install pnpm with npm:

```bash
npm install -g pnpm
```

Install dependencies:

```bash
pnpm install
```

Common commands:

```bash
pnpm build
pnpm dev
pnpm test
pnpm lint
pnpm type-check
```

For complete environment setup (SQLite/PostgreSQL, API/UI/server startup), see:
[docs/guides/local-setup-and-run.md](./docs/guides/local-setup-and-run.md)

## Auth and Filtering

The current main path supports:

- Bearer token authentication
- custom request headers
- endpoint filtering by method, path, `operationId`, status code, and parameters

Example:

```bash
api-nova \
  --openapi https://api.example.com/openapi.json \
  --transport streamable \
  --auth-type bearer \
  --bearer-env API_TOKEN \
  --operation-filter-methods GET \
  --operation-filter-methods POST
```

## Documentation Entry Points

Current active project governance and entry documents:

- [Product Constraints](./PRODUCT_CONSTRAINTS.md)
- [Project Baseline](./PROJECT_BASELINE.md)
- [Release Baseline](./RELEASE_BASELINE_V1.md)
- [Project Analysis and Plan](./PROJECT_ANALYSIS_AND_V1_PLAN.md)
- [Documentation Index](./docs/README.md)

The `docs/` directory is now organized as:

- `docs/guides`
  active setup, usage, deployment, auth, and troubleshooting docs
- `docs/reference`
  current release and protocol reference material
- `docs/archive`
  archived plans, summaries, old designs, and historical material

## Current Working Rules

- converge the releasable baseline before expanding features
- treat external design notes as reference, not direct implementation truth
- keep both Windows and Linux/Ubuntu supported
- keep CLI, API, UI, and docs aligned on main-path behavior

## License

MIT. See [LICENSE](./LICENSE).
