import type { EntityManager } from 'typeorm';
import { RuntimeAssetEntity } from '../../../database/entities/runtime-asset.entity';
import { RuntimeAssetEndpointBindingEntity } from '../../../database/entities/runtime-asset-endpoint-binding.entity';
import { EndpointDefinitionEntity } from '../../../database/entities/endpoint-definition.entity';
import { SourceServiceAssetEntity } from '../../../database/entities/source-service-asset.entity';

export interface McpOwnershipRead {
  asset: RuntimeAssetEntity;
  rows: Array<{ membership: RuntimeAssetEndpointBindingEntity; endpointDefinition: EndpointDefinitionEntity | null; sourceServiceAsset: SourceServiceAssetEntity | null }>;
}
/** One SELECT captures only runtime/membership/endpoint/source ownership.
 * Publication, profiles and upstream resolution are outside this read boundary.
 * LEFT JOIN retains dangling memberships so selected invalid rows fail closed.
 */
export async function readMcpOwnership(manager: EntityManager, runtimeAssetId: string): Promise<McpOwnershipRead | null> {
  type JoinedMembership = RuntimeAssetEndpointBindingEntity & { ownershipEndpoint?: EndpointDefinitionEntity & { ownershipSource?: SourceServiceAssetEntity } };
  type JoinedAsset = RuntimeAssetEntity & { ownershipMemberships?: JoinedMembership[] };
  const asset = await manager.createQueryBuilder(RuntimeAssetEntity, 'asset')
    .leftJoinAndMapMany('asset.ownershipMemberships', RuntimeAssetEndpointBindingEntity, 'membership', 'membership.runtimeAssetId = asset.id')
    .leftJoinAndMapOne('membership.ownershipEndpoint', EndpointDefinitionEntity, 'endpoint', 'endpoint.id = membership.endpointDefinitionId')
    .leftJoinAndMapOne('endpoint.ownershipSource', SourceServiceAssetEntity, 'source', 'source.id = endpoint.sourceServiceAssetId')
    .where('asset.id = :runtimeAssetId', { runtimeAssetId })
    .orderBy('membership.updatedAt', 'DESC').addOrderBy('membership.id', 'ASC')
    // Use limit, not take: TypeORM take with joins may emit a second SELECT.
    .limit(10001).getOne() as JoinedAsset | null;
  if (!asset) return null;
  const memberships = asset.ownershipMemberships || [];
  if (memberships.length > 10000) throw new Error('MCP_OWNERSHIP_READ_TOO_LARGE');
  const rows = memberships.map(member => {
    const { ownershipEndpoint, ...membership } = member;
    const { ownershipSource, ...endpointDefinition } = ownershipEndpoint || {};
    return { membership: membership as RuntimeAssetEndpointBindingEntity,
      endpointDefinition: ownershipEndpoint ? endpointDefinition as EndpointDefinitionEntity : null,
      sourceServiceAsset: ownershipSource || null };
  });
  delete asset.ownershipMemberships;
  return { asset, rows };
}