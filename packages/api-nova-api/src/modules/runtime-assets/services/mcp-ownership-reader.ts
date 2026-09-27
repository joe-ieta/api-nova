import { PublicationProfileEntity } from '../../../database/entities/publication-profile.entity';
import { EndpointPublishBindingEntity } from '../../../database/entities/endpoint-publish-binding.entity';
import type { EntityManager } from 'typeorm';
import { RuntimeAssetEntity } from '../../../database/entities/runtime-asset.entity';
import { RuntimeAssetEndpointBindingEntity } from '../../../database/entities/runtime-asset-endpoint-binding.entity';
import { EndpointDefinitionEntity } from '../../../database/entities/endpoint-definition.entity';
import { SourceServiceAssetEntity } from '../../../database/entities/source-service-asset.entity';

export interface McpOwnershipRead {
  asset: RuntimeAssetEntity;
  rows: Array<{ membership: RuntimeAssetEndpointBindingEntity; endpointDefinition: EndpointDefinitionEntity | null; sourceServiceAsset: SourceServiceAssetEntity | null; profile: PublicationProfileEntity | null; publishBinding: EndpointPublishBindingEntity | null }>;
}
/** One SELECT captures ownership, the latest membership profile and publication.
 * Upstream resolution remains outside this statement boundary.
 * LEFT JOIN retains dangling memberships so selected invalid rows fail closed.
 */
export async function readMcpOwnership(manager: EntityManager, runtimeAssetId: string): Promise<McpOwnershipRead | null> {
  type JoinedMembership = RuntimeAssetEndpointBindingEntity & { ownershipProfile?: PublicationProfileEntity; ownershipPublication?: EndpointPublishBindingEntity; ownershipEndpoint?: EndpointDefinitionEntity & { ownershipSource?: SourceServiceAssetEntity } };
  type JoinedAsset = RuntimeAssetEntity & { ownershipMemberships?: JoinedMembership[] };
  // PostgreSQL models generated primary keys as uuid while the ownership foreign
  // columns are varchar(36). Cast the uuid side to text so these joins run on
  // both dialects without a migration or a schema drift.
  const idColumn = (column: string) => manager.connection.options.type === 'postgres' ? `${column}::text` : column;
  const membershipId = idColumn('membership.id');
  const latestVersion = manager.createQueryBuilder(PublicationProfileEntity, 'profile_version')
    .select('MAX(profile_version.version)')
    .where(`profile_version.runtimeAssetEndpointBindingId = ${membershipId}`).getQuery();
  const asset = await manager.createQueryBuilder(RuntimeAssetEntity, 'asset')
    .leftJoinAndMapMany('asset.ownershipMemberships', RuntimeAssetEndpointBindingEntity, 'membership', `${idColumn('asset.id')} = membership.runtimeAssetId`)
    .leftJoinAndMapOne('membership.ownershipEndpoint', EndpointDefinitionEntity, 'endpoint', `${idColumn('endpoint.id')} = membership.endpointDefinitionId`)
    .leftJoinAndMapOne('endpoint.ownershipSource', SourceServiceAssetEntity, 'source', `${idColumn('source.id')} = endpoint.sourceServiceAssetId`)
    .leftJoinAndMapOne('membership.ownershipPublication', EndpointPublishBindingEntity, 'publication', `publication.runtimeAssetEndpointBindingId = ${membershipId}`)
    .leftJoinAndMapOne('membership.ownershipProfile', PublicationProfileEntity, 'profile',
      `profile.runtimeAssetEndpointBindingId = ${membershipId} AND profile.version = (` + latestVersion + ')')
    .where('asset.id = :runtimeAssetId', { runtimeAssetId })
    .orderBy('membership.updatedAt', 'DESC').addOrderBy('membership.id', 'ASC')
    // Use limit, not take: TypeORM take with joins may emit a second SELECT.
    .limit(10001).getOne() as JoinedAsset | null;
  if (!asset) return null;
  const memberships = asset.ownershipMemberships || [];
  if (memberships.length > 10000) throw new Error('MCP_OWNERSHIP_READ_TOO_LARGE');
  const rows = memberships.map(member => {
    const { ownershipEndpoint, ownershipProfile, ownershipPublication, ...membership } = member;
    const { ownershipSource, ...endpointDefinition } = ownershipEndpoint || {};
    return { membership: membership as RuntimeAssetEndpointBindingEntity,
      endpointDefinition: ownershipEndpoint ? endpointDefinition as EndpointDefinitionEntity : null,
      sourceServiceAsset: ownershipSource || null, profile: ownershipProfile || null, publishBinding: ownershipPublication || null };
  });
  delete asset.ownershipMemberships;
  return { asset, rows };
}