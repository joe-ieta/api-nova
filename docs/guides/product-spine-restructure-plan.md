# Product Spine Restructure Plan

## Purpose

This document defines the next product-mainline restructuring for ApiNova.

The goal is not to patch isolated UI inconsistencies.

The goal is to rebuild the top-level product spine so operator workflows match the corrected asset model:

- API registration
- API testing
- API governance
- API publication

## 1. Problem Statement

The current implementation has materially corrected the backend asset model, but the top-level product workflow still mixes old and new concepts.

The main symptoms are:

1. OpenAPI import feels like a relatively complete flow from import to MCP publication
2. manual endpoint registration feels like a different product path
3. some product and service surfaces still describe registration and publication too closely, even though registration-time MCP carrier creation has been removed from the main path
4. testing exists as a separate capability, but it is not yet a clear gate in the main asset lifecycle
5. endpoint governance and runtime publication are still partially mixed in the same operator surface

This gives users the wrong impression that:

- registration already means publication
- manual endpoints and imported endpoints are different product objects
- MCP Server creation is a side effect of registration rather than a later publication result

## 2. Corrected Product Spine

ApiNova should expose four top-level product stages:

1. API Registration
2. API Testing
3. API Governance
4. API Publication

These stages describe different lifecycle steps and should not collapse into one mixed screen.

## 3. Stage Definitions

### 3.1 API Registration

Purpose:

- bring APIs into the system as managed assets

Supported registration methods:

1. import OpenAPI
2. manual endpoint registration

This stage should only create catalog-side assets:

- `source_service_asset`
- `endpoint_definition`

This stage should not expose:

- publish
- deploy
- online or offline control
- runtime start or stop

Registration means the API is cataloged, not yet validated for runtime publication.

### 3.2 API Testing

Purpose:

- verify that registered endpoints are functionally callable

This stage should reuse the existing testing capability but connect it to the endpoint lifecycle.

Testing should answer:

- does the endpoint respond correctly
- does the request shape work
- does the operator have enough confidence to move it into governance readiness work

Testing is not the same as runtime governance health.

Testing is the functional validation gate before the endpoint is treated as publication-ready input.

### 3.3 API Governance

Purpose:

- normalize registered and tested endpoints into usable governed assets

This stage should include:

- probe validation
- readiness checks
- metadata completion
- ownership and classification
- lifecycle review
- readiness judgement

The result of this stage is:

- endpoint assets that become `Ready`

This stage is still endpoint-centered.

It should not yet create runtime publication identity.

### 3.4 API Publication

Purpose:

- publish only `Ready` endpoints into runtime assets

This stage should support two publication paths:

1. publish as MCP runtime assets
2. publish as Gateway runtime assets

This stage should own:

- publication grouping
- runtime membership
- runtime asset creation
- publication revisioning
- deploy and redeploy entry points

Publication is where runtime identity appears.

It should not be a side effect of registration.

## 4. Product State Model

### 4.1 Endpoint lifecycle stages

Recommended top-level asset stages:

- `registered`
- `tested`
- `governed`
- `ready`

These stages describe asset maturity, not runtime publication.

### 4.2 Publication stages

Recommended publication states:

- `unpublished`
- `published_to_mcp`
- `published_to_gateway`
- `published_to_both`
- `offline`

These stages describe runtime exposure, not registration maturity.

### 4.3 Why the split matters

This separation avoids the current confusion where:

- registering an endpoint can appear to create an MCP Server
- imported endpoints feel publish-oriented while manual endpoints feel registry-oriented

## 5. Asset-Layer Interpretation

The corrected product spine must stay aligned with the asset model.

### 5.1 Registration layer

Owns:

- `source_service_asset`
- `endpoint_definition`

### 5.2 Governance layer

Owns:

- endpoint-level readiness
- endpoint-level metadata
- endpoint-level validation state

### 5.3 Publication layer

Owns:

- `runtime_asset`
- `runtime_asset_endpoint_binding`
- publication profile and publication revision

### 5.4 Runtime layer

Owns:

- MCP runtime operation
- Gateway runtime operation
- runtime observability
- runtime policy and control

## 6. Current Drift Against This Model

The current codebase still has several concrete product-flow drifts:

1. publication internals had retained legacy `MCPServerEntity` dependencies and `legacyEndpointId` compatibility links, and these should now be treated as a closure target rather than an active baseline assumption
2. endpoint registry UI still mixes registration follow-up, governance, readiness, publish, and offline actions in one page
3. top-level UI navigation has been corrected, but the registration surface is still split between import-first and manual-entry pages
4. OpenAPI import still feels like the main product story, while manual registration feels like a side path
5. residual server-first frontend store and websocket assumptions still exist in some management flows

That is structurally wrong under the corrected asset model because:

- registration should produce catalog assets
- publication should produce runtime assets

The current OpenAPI path also still over-expresses publication meaning inside an import-centered operator surface.

### 6.1 Current implementation cross-check

The following implementation areas are the main confirmed drift sources:

- `packages/api-nova-api/src/modules/publication/services/publication.service.ts`
  publication was one of the main drift sources because it previously resolved endpoint context through `MCPServerEntity` and compatibility metadata such as `legacyEndpointId`
- `packages/api-nova-ui/src/modules/endpoint-registry/EndpointRegistry.vue`
  one mixed surface still exposes probe, readiness, publish, offline, governance-edit, and manual creation together
- `packages/api-nova-ui/src/modules/openapi/OpenAPIManager.vue`
  OpenAPI import remains a stronger top-level product surface than unified registration
- `packages/api-nova-ui/src/stores/server.ts`
  `packages/api-nova-ui/src/stores/websocket.ts`
  `packages/api-nova-ui/src/composables/useStores.ts`
  residual selected-server assumptions are still coupled to older server-first management flow
- active documentation had stale references to registration-time MCP creation and `servers/api-center/*` as active contracts, and those references should now be treated as historical rather than active baseline

## 7. Required Product Surface Changes

### 7.1 Top-level navigation

Top-level product structure should move toward:

1. API Registration
2. API Testing
3. API Governance
4. API Publication
5. Runtime Assets
6. Monitoring

`Runtime Assets` and `Monitoring` remain downstream operational views rather than registration views.

### 7.2 Registration surface

The registration page should contain two entry modes:

1. Import OpenAPI
2. Manual registration

Both must converge into one registration result model.

### 7.3 Testing surface

The testing page should become an explicit gate in the main flow.

### 7.4 Governance surface

The governance page should operate on endpoint assets, not mixed MCP server identity.

### 7.5 Publication surface

The publication page should expose:

- ready endpoint groups
- MCP publication path
- Gateway publication path
- runtime-asset membership assembly

## 8. Implementation Stages

### Stage A: Rebuild top-level product structure

Goal:

- make the product navigation and conceptual model match the corrected spine

Main work:

1. define the four top-level workflow concepts in active docs
2. reorder UI navigation and page ownership
3. stop presenting OpenAPI import as the only primary product entry
4. stop presenting manual registration as a different product object

Exit:

- top-level product surfaces reflect registration, testing, governance, and publication as separate stages

### Stage B: Unify API Registration

Goal:

- make import and manual registration two entry methods under one registration concept

Main work:

1. create one unified API registration surface
2. route import and manual registration into the same catalog result model
3. remove product-level wording that implies registration already created runtime publication artifacts

Exit:

- both registration methods feel like one workflow

### Stage C: Connect API Testing to the main flow

Goal:

- treat testing as an explicit functional validation gate

Main work:

1. map testing inputs to registered endpoint assets
2. persist endpoint-level test result summary
3. block downstream governance readiness shortcuts when functional testing has not passed

Exit:

- testing becomes part of the main spine rather than a detached utility

### Stage D: Rebuild API Governance around endpoint readiness

Goal:

- make endpoint governance the place where assets become `Ready`

Main work:

1. consolidate probe, readiness, classification, and lifecycle review into one endpoint-governance surface
2. define explicit readiness rules
3. remove remaining server-first presentation from the governance entry

Exit:

- ready endpoints are clearly identified before publication

### Stage E: Rebuild API Publication

Goal:

- publish ready endpoints through two explicit runtime paths

Main work:

1. build one publication surface for MCP and Gateway paths
2. expose runtime membership grouping explicitly
3. make MCP and Gateway publication outcomes visible as separate runtime assets

Exit:

- runtime publication becomes explicit and no longer hides inside registration or import flows

### Stage F: Remove transitional runtime-creation shortcuts

Goal:

- complete the architectural correction after the product spine is stable

Main work:

1. stop creating MCP carrier records during manual endpoint registration
2. create runtime records only inside publication and deploy paths
3. retire remaining mixed server-first compatibility assumptions from the main product flow

Exit:

- registration, governance, and publication no longer leak into one another

## 9. Migration Rule

During this restructuring:

1. do not add more product-facing shortcuts that mix registration and publication
2. do not hide runtime creation behind registration success
3. prefer explicit stage transitions over convenience side effects
4. preserve the corrected asset model even if temporary UI compatibility remains

## 10. Immediate Execution Recommendation

The next mainline should start with:

1. Stage A: top-level product structure rewrite
2. Stage B: API registration unification
3. Stage C: testing gate integration

Only after that should deeper publication and compatibility cleanup continue.
