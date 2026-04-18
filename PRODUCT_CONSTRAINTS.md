# ApiNova Product Constraints

## Purpose

This document defines the top-level constraints for all follow-up optimization and upgrade work in this repository.

## Product Positioning

ApiNova is an AI-ready API capabilities product positioned as an application-internal product gateway and management platform with dual access paths.

It turns OpenAPI/Swagger-described APIs into governed endpoint assets and publishes them through:

- MCP tools for model-driven invocation
- HTTP gateway routes for direct service invocation

The repository contains four product layers:

- `packages/api-nova-parser`: parsing, normalization, validation, spec compatibility
- `packages/api-nova-server`: MCP tool generation and MCP transport runtime
- `packages/api-nova-api`: product backend, shared control plane, persistence, security, HTTP gateway runtime
- `packages/api-nova-ui`: product frontend and operator workflow

## Top-Level Constraints

### 1. Single source of truth for core behavior

- Parsing, normalization, validation, Swagger 2 conversion, and shared request-shaping logic must converge toward shared core implementations.
- API and UI must orchestrate core capabilities, not maintain competing transformation logic.

### 2. Shared control plane, dual runtime surfaces

- Endpoint registry, publication policy, auth configuration, lifecycle, and observability belong to one shared control plane.
- MCP publication and HTTP gateway publication are parallel surfaces over the same governed endpoint assets.
- The two runtime surfaces may differ in protocol behavior, but they must not diverge in endpoint identity, governance state, or publication source of truth.

### 3. Documentation is part of the product

- README, package docs, API docs, CLI help, and UI guidance must reflect actual runtime behavior.
- Documentation drift is treated as a product defect.

### 4. Security defaults must be explicit

- Management and mutation flows should default to protected access unless intentionally exposed.
- HTTP gateway publication must not silently bypass the auth and lifecycle constraints applied to the same endpoint on the MCP path.

### 5. Transport safety is a product requirement

- `stdio`, `sse`, and `streamable` are product surfaces.
- Library/runtime code must avoid uncontrolled stdout noise that can corrupt protocol streams.

### 6. Observability without pollution

- Operational visibility is required, but logging must be structured and gated.
- Management metrics, MCP runtime metrics, and HTTP gateway metrics should be distinguishable.

### 7. Cross-platform runtime compatibility

- Product changes must preserve support for Windows and Linux, with Ubuntu treated as a first-class target.
- Avoid hard-coded shell behavior, paths, separators, signals, encodings, or process assumptions that only work on one platform.

### 8. Brand, naming, and port invariants must not drift

- Active product identity: `ApiNova`
- Chinese name: `达雅`
- `Api达雅` may be used as a mixed-form expression in Chinese contexts
- Default ports remain `9000` / `9001` / `9022`

### 9. Localization and encoding discipline must not drift

- Chinese is the default operator locale.
- Active docs and operator copy must be stored with stable UTF-8 encoding.
- Readable fallback text is acceptable; corrupted text is not.

### 10. Gateway boundary discipline must not drift

- ApiNova is not an enterprise heavy gateway for full traffic takeover.
- It should not replace an existing business gateway, edge gateway, or service mesh.
- It may provide route binding, auth injection, policy checks, observability, and controlled HTTP forwarding for governed and published endpoints.
- Complex layer-7 routing and organization-wide traffic governance are outside the current baseline.

## Delivery Priorities

1. Correctness of the governed endpoint main path
2. Contract consistency across CLI/API/UI/docs
3. Publication consistency across MCP and HTTP gateway surfaces
4. Security and transport safety
5. Operational reliability and maintainability
6. Feature expansion
