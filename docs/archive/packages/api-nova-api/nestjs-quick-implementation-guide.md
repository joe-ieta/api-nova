# NestJS Quick Implementation Guide

> Document status: Archived
> Archived on: 2026-07-22
> Reason: Historical package implementation guide.

## Prerequisites

```bash
node --version
npm --version
```

Required versions:

- Node.js 20+
- npm 10+

## Install

Run from the repository root:

```bash
npm install
```

The API package is managed by the root npm workspace. Do not create a nested lockfile inside `packages/api-nova-api`.

## Development

Start the API:

```bash
npm run start:dev --workspace api-nova-api
```

Start the UI in a second terminal:

```bash
npm run dev --workspace api-nova-ui
```

Open:

```text
http://127.0.0.1:9001/api/docs
http://127.0.0.1:9000/
```

## Build And Test

```bash
npm run build --workspace api-nova-api
npm run test --workspace api-nova-api
npm run type-check --workspace api-nova-api
```

Full repository build:

```bash
npm run build
```

## Database

SQLite is the default mode:

```env
DB_TYPE=sqlite
DB_SQLITE_PATH=data/api_nova.db
DB_SYNCHRONIZE=true
```

For a blank local environment, remove the SQLite file and restart the API. The schema and seed data are recreated automatically.
