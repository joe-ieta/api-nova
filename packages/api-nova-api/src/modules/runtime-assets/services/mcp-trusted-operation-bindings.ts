import { compileTrustedOperationBindings, type OpenAPISpec, type TrustedOperationBinding } from 'api-nova-parser';
import type { RuntimeAssetEntity } from '../../../database/entities/runtime-asset.entity';
import type { RuntimeAssetEndpointBindingEntity } from '../../../database/entities/runtime-asset-endpoint-binding.entity';
import type { EndpointDefinitionEntity } from '../../../database/entities/endpoint-definition.entity';
import type { SourceServiceAssetEntity } from '../../../database/entities/source-service-asset.entity';

export interface McpOperationOwnershipRow {
  readonly membership: Pick<RuntimeAssetEndpointBindingEntity, 'id' | 'runtimeAssetId' | 'endpointDefinitionId' | 'enabled' | 'status'>;
  readonly endpoint: Pick<EndpointDefinitionEntity, 'id' | 'sourceServiceAssetId' | 'method' | 'path' | 'status'>;
  readonly sourceAsset: Pick<SourceServiceAssetEntity, 'id'>;
}

/**
 * Pure adapter for rows read by trusted management code. Callers must read these
 * rows and assemble the spec from the same consistent repository snapshot.
 * This checks relational identity, not caller permissions/publication eligibility.
 * No runtime entry enables this automatically; persisted OpenAPI extensions are
 * deliberately not used as ownership evidence. Revocation requires a fresh read.
 */
export function createMcpTrustedOperationBindings(
  runtimeAsset: Pick<RuntimeAssetEntity, 'id' | 'type'>,
  selectedRows: readonly McpOperationOwnershipRow[],
  spec: OpenAPISpec,
): readonly TrustedOperationBinding[] {
  try {
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const validId = (value: unknown): value is string => typeof value === 'string' && uuid.test(value);
    if (!runtimeAsset || !validId(runtimeAsset.id) || runtimeAsset.type !== 'mcp_server' ||
      !Array.isArray(selectedRows) || selectedRows.length > 10000) throw new Error();
    const memberships = new Set<string>();
    const endpoints = new Set<string>();
    const bindings = selectedRows.map(row => {
      const { membership, endpoint, sourceAsset } = row;
      if (!membership || !endpoint || !sourceAsset || membership.enabled !== true ||
        !['draft', 'active'].includes(membership.status) || !['draft', 'verified', 'published', 'degraded'].includes(endpoint.status) ||
        !validId(membership.id) || !validId(endpoint.id) || !validId(sourceAsset.id) ||
        membership.runtimeAssetId !== runtimeAsset.id || membership.endpointDefinitionId !== endpoint.id ||
        endpoint.sourceServiceAssetId !== sourceAsset.id || memberships.has(membership.id) || endpoints.has(endpoint.id)) throw new Error();
      memberships.add(membership.id); endpoints.add(endpoint.id);
      return Object.freeze({ method: endpoint.method.toUpperCase(), path: endpoint.path,
        endpointDefinitionId: endpoint.id, sourceServiceAssetId: sourceAsset.id });
    });
    const compiled = compileTrustedOperationBindings(spec, bindings);
    // The generated spec and selected rows must describe precisely the same operations.
    for (const [path, item] of Object.entries(spec.paths)) {
      for (const method of ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']) {
        if (Object.prototype.hasOwnProperty.call(item, method) && !compiled.get(method, path)) throw new Error();
      }
    }
    return Object.freeze(bindings);
  } catch {
    // No raw operation, path, identity, or getter error enters public diagnostics.
    throw new Error('INVALID_MCP_OPERATION_OWNERSHIP');
  }
}