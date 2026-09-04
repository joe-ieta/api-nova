# api-nova-parser

> OpenAPI / Swagger specification parser for ApiNova and AI-ready API workflows

## Overview

A TypeScript library for parsing, validating, normalizing, and extracting information from OpenAPI / Swagger specifications. This package serves as the parser foundation for the ApiNova workspace.

## Features

- Multi-format support: JSON, YAML, URL, and local file inputs
- Specification validation: OpenAPI 3.x and Swagger 2.0 compatibility handling
- Metadata extraction: endpoints, schemas, security schemes, and document metadata
- Type-safe usage: comprehensive TypeScript type definitions
- Reusable parser chain: shared by runtime, API, and UI packages

## Installation

```bash
npm install api-nova-parser
```

## Quick Start

```typescript
import { OpenApiParser } from 'api-nova-parser';

const parser = new OpenApiParser();

const spec = await parser.parseFromUrl('https://petstore.swagger.io/v2/swagger.json');

console.log('API Info:', spec.info);
console.log('Endpoints:', spec.metadata.endpointCount);
```

## Contributing

This package is part of the ApiNova monorepo. See the [main repository](../../README.md) for contribution guidelines and active product constraints.

## License

MIT License. See [LICENSE](../../LICENSE).

## Related Packages

- [api-nova-server](../api-nova-server/) - MCP runtime package
- [api-nova-api](../api-nova-api/) - management backend
- [api-nova-ui](../api-nova-ui/) - operator interface
