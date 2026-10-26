---
doc-version: 1.1.0
doc-status: active
doc-updated: 2026-10-26
---
# ApiNova

[中文](./README.md) | English

ApiNova governs existing HTTP APIs and publishes them through HTTP Gateway routes and MCP tools. The workflow is registration → testing → governance → publication → operation and observation.

The repository contains Parser, MCP Server, API/control plane with HTTP Gateway, and UI workspaces. SQLite is the default; PostgreSQL is optional. MCP transports are stdio, streamable and sse; management Socket.IO is separate.

The latest delivered candidate is **v1.7.6-rc.5**, a manual-testing prerelease. Production acceptance remains open. The post-merge October 26 dependency scan reports 7 high and 9 moderate package nodes; disposition remains in the existing security work item. Documentation updates do not replace published artifacts.

## Reading and running

- [Documentation hub and reading order](./docs/README.md)
- [Product scope](./docs/overview/PRODUCT.md) and [architecture](./docs/architecture/OVERALL_DESIGN.md)
- [Deployment](./docs/guides/DEPLOYMENT.md) and [operator workflow](./docs/guides/USER_GUIDE.md)
- [Developer integration](./docs/development/DEVELOPER_GUIDE.md), [API manual](./docs/api/README.md), [endpoint inventory](./docs/api/ENDPOINTS.md)
- [Current open items](./docs/reference/open-items.md) and [release standard](./RELEASE_STANDARD.md)

For an offline package, select the matching native OS/CPU artifact, extract it completely, run start.bat or ./start.sh, and open http://127.0.0.1:9001/. The documented local test account is admin / admin@123456; change the password and JWT secrets before network sharing. Follow the version quick start for exact restrictions.

For source development, run npm ci and npm run build at the repository root, then start API, UI and Server in separate terminals as documented. The root dev helper does not start the complete API. Product tags and npm workspace versions are different identifiers.

ApiNova originated from [mcp-swagger-server](https://github.com/zaizaizhao/mcp-swagger-server). Current documentation is consolidated in the hub; dated plans, audits and superseded references are retained in the [archive](./docs/archive/README.md).
