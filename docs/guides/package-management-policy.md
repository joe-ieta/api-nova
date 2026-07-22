# Package Management Policy

> Document status: Active canonical policy
> Last reviewed: 2026-07-22

## Decision

Repository development, dependency resolution, workspace orchestration, CI, build, packaging, and release use npm only.

Published packages use the standard npm package format. Downstream consumers may install them with npm, pnpm, or Yarn, but those package managers are not supported for developing or releasing this repository.

## Supported Toolchain

- Node.js `>= 20`
- npm `>= 10`
- repository-declared package manager: `npm@10.9.2`
- workspace definition: root `package.json` with `workspaces: ["packages/*"]`
- authoritative dependency lock: root `package-lock.json`

The repository must not contain `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `yarn.lock`, or package-manager-specific workspace configuration for another tool.

## Clean Setup

From the repository root:

```bash
node -v
npm -v
npm ci
npm run verify:package-manager
npm run build
```

Use `npm ci` for a clean clone, CI job, release verification, or environment rebuild. It removes the existing dependency tree and recreates it exactly from `package-lock.json`.

Use `npm install` only when intentionally adding, removing, or updating dependencies, and commit the resulting `package.json` and `package-lock.json` changes together.

## Workspace Commands

```bash
# Run a script in one workspace
npm run build --workspace api-nova-api

# Run a script across workspaces when present
npm run type-check --workspaces --if-present

# Run the repository build orchestrator
npm run build

# Run the release closure gate
npm run verify:runtime-closure
```

Package scripts and repository automation must call npm workspace commands or package-manager-neutral Node.js scripts. They must not invoke pnpm or Yarn internally.

## CI, Packaging, And Release

- CI installs dependencies with `npm ci`.
- CI caches npm data using `package-lock.json` as the cache key input.
- offline development kits carry an npm cache and restore with `npm ci --offline`.
- release packaging installs production dependencies with `npm ci --omit=dev`.
- Changesets and package publication are invoked through root npm scripts.

## Consumer Compatibility

The `api-nova-parser` and `api-nova-server` publication artifacts must remain valid standard npm packages without repository-only paths or package-manager-specific protocols. Consumer-facing examples use npm as the canonical command. Compatibility with pnpm and Yarn is verified at the package artifact boundary, not by maintaining additional repository lock files.

## Verification

Run:

```bash
npm run verify:package-manager
```

The check validates the declared npm baseline, required npm lock file, absence of competing workspace artifacts, lifecycle package manager, and executable automation under `scripts/` and `.github/`.
