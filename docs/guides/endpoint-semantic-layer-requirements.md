# Endpoint Publication Profile Requirements

## 1. Background

The current system mainly converts raw OpenAPI endpoint descriptions directly into MCP tools. That path is already usable, but it is not enough for the new product baseline.

The product now needs a corrected asset model with:

- source service assets
- endpoint item assets
- runtime assets

Within that model, endpoint members must support two access paths at the same time:

- MCP tools for model-driven invocation
- HTTP gateway routes for traditional service invocation

Therefore a lightweight, editable, versioned publication layer must be added between raw OpenAPI meaning and public runtime exposure, and that layer must attach to the correct publish unit.

## 2. Goals And Scope

### 2.1 Goals

- support endpoint publication shaping before runtime exposure
- improve endpoint readability and task meaning for MCP publication
- provide a shared publish-time profile for both MCP tools and HTTP gateway routes
- support automatic draft generation plus human review and override
- support revisioning, publication status control, and rollback

### 2.2 MVP Scope

- add publication profiles for runtime-asset endpoint membership
- add automatic draft generation from OpenAPI metadata
- add operator review and publish controls
- add MCP publication override rules
- add HTTP gateway route binding based on the same publication profile
- add publication revision history and traceability

### 2.3 Non-goals For This Stage

- introducing a complex NLP pipeline or training system
- implementing cross-tenant heavy gateway strategy orchestration
- turning ApiNova into an enterprise full-traffic gateway
- replacing raw OpenAPI storage with semantic-only data

## 3. Functional Requirements

### 3.1 Publication Profile

Each published endpoint membership should have one current effective publication profile. Recommended core fields:

- `intent_name`
- `description_for_llm`
- `operator_notes`
- `input_aliases`
- `constraints`
- `examples`
- `visibility`
- `status`
- `version`

### 3.2 Dual Publish Binding

Publication must support two runtime paths over the same underlying endpoint item:

- `mcp_publish_binding`
- `gateway_route_binding`

### 3.3 Automatic Draft Generation

After importing OpenAPI, the system should automatically generate a publication draft.

Draft generation priority should be based on:

1. endpoint `summary`, `description`, and `tags`
2. request schema fields and enums
3. `operationId` tokenization and name cleanup

### 3.4 Manual Review And Approval

- support profile editing in UI and management APIs
- support previewing the published MCP tool metadata
- support previewing the published HTTP gateway route binding
- only `reviewed` and `published` states may enter public publication flows

### 3.5 Publish Override Rules

When building published runtime output, field priority should be:

1. manually maintained publication profile fields
2. automatically generated draft fields
3. raw OpenAPI fields

### 3.6 Revision And Traceability

- each publication action should write a snapshot into history storage
- MCP tool metadata should record publication revision information
- HTTP route bindings should record route and publication revision information
- rollback to a previous publication revision should be supported

## 4. Suggested Data Model

The baseline model should include at least:

- `source_service_asset`
- `endpoint_definition`
- `runtime_asset`
- `runtime_asset_endpoint_binding`
- `publication_profile`
- `publication_profile_history`
- gateway-specific binding fields for `gateway_service_asset`

The model should remain compatible with both SQLite and PostgreSQL.

## 5. State Model

Recommended status flow:

- `draft -> reviewed -> published -> offline`
- `published -> reviewed`
- `offline -> reviewed/published`

Publication preconditions:

- endpoint operational status is eligible for publication
- runtime asset membership is valid
- publication profile status is `published`
- route conflict checks pass
- auth or permission policy checks pass when enabled

## 6. Implementation Stages

### Stage 1: Data And Service Foundation

- add tables and migrations
- add `PublicationProfileService`
- add validation for state transitions
- add publication draft generation

### Stage 2: Publication Runtime Integration

- apply publication overrides during MCP tool publication
- add publication revision metadata to MCP output
- add HTTP gateway route binding resolution
- add runtime publication snapshot persistence

### Stage 3: Operator Workflows

- publication profile list and detail views
- review and publish actions
- MCP preview and HTTP route preview
- history and rollback entry points

### Stage 4: Quality Verification

- unit tests for override priority, state transitions, and rollback
- integration tests for MCP and HTTP publication paths
- cross-database verification on SQLite and PostgreSQL
