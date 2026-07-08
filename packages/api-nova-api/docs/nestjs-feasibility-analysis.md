# NestJS Feasibility Analysis

## Current Decision

NestJS remains the API service framework for ApiNova. The current project baseline is:

- TypeScript
- npm workspaces
- NestJS 10
- TypeORM
- SQLite by default, PostgreSQL optional
- Vue 3 UI served separately in development and copied to `public/` for release packages

## Fit With The Monorepo

The API package consumes local workspace packages through npm workspace linking:

```json
{
  "dependencies": {
    "api-nova-parser": "1.7.0",
    "api-nova-server": "1.7.0"
  }
}
```

This keeps package manifests valid for npm publication while local installs still use workspace packages from the repository.

## Operational Fit

NestJS is suitable for the API service because it provides:

- structured modules and dependency injection
- controller/service separation
- validation and OpenAPI documentation
- guards and interceptors for security workflows
- TypeORM integration for SQLite and PostgreSQL
- straightforward build output for release packaging

## Commands

```bash
npm install
npm run build
npm run start:dev --workspace api-nova-api
```

## Release Fit

The npm workspace structure is compatible with portable release packages as long as the generated package includes the root lockfile and workspace package metadata. First run installs production dependencies with:

```bash
npm ci --omit=dev
```
