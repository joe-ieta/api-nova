# NestJS Technical Specifications

> Document status: Archived
> Archived on: 2026-07-22
> Reason: Historical package technical specification.

## Baseline

- Runtime: Node.js 20+
- Package manager: npm workspaces
- API port: 9001
- MCP runtime port: 9022
- Default database: SQLite
- Optional database: PostgreSQL

## Workspace Layout

The API package is part of the root npm workspace:

```text
api-nova
├── package.json
├── package-lock.json
└── packages
    ├── api-nova-api
    ├── api-nova-parser
    ├── api-nova-server
    └── api-nova-ui
```

Workspace package dependencies should use published package versions in `package.json`, while npm links local workspaces during install:

```json
{
  "dependencies": {
    "api-nova-parser": "1.7.0",
    "api-nova-server": "1.7.0"
  }
}
```

## Commands

Run from the repository root:

```bash
npm install
npm run build
npm run start:dev --workspace api-nova-api
```

Per-package checks:

```bash
npm run build --workspace api-nova-api
npm run test --workspace api-nova-api
npm run type-check --workspace api-nova-api
```

## Docker Baseline

The Docker build context is the repository root so npm can resolve local workspaces:

```dockerfile
FROM node:20-alpine
WORKDIR /app

COPY package.json package-lock.json .npmrc ./
COPY packages/api-nova-api/package.json ./packages/api-nova-api/package.json
COPY packages/api-nova-parser/package.json ./packages/api-nova-parser/package.json
COPY packages/api-nova-server/package.json ./packages/api-nova-server/package.json

RUN npm ci --workspace api-nova-api --workspace api-nova-parser --workspace api-nova-server --include-workspace-root
```

## Release Notes

Release packages use `npm ci --omit=dev` on first run in portable mode. The generated package must include:

- root `package.json`
- root `package-lock.json`
- root `.npmrc`
- package metadata for workspace packages
- built API, parser, and server `dist/` output
- built UI static assets under `public/`
