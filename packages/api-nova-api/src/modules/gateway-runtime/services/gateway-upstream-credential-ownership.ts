import { DataSource } from 'typeorm';
import type { UpstreamCredentialBindingsCandidate } from 'api-nova-parser';
import { SourceServiceAssetEntity } from '../../../database/entities/source-service-asset.entity';
import { EndpointDefinitionEntity } from '../../../database/entities/endpoint-definition.entity';

/** Validate one candidate against a consistent authoritative database view. No caller IDs are trusted. */
export async function validateGatewayCredentialOwnership(
  dataSource: DataSource, candidate: UpstreamCredentialBindingsCandidate,
): Promise<void> {
  await dataSource.transaction('SERIALIZABLE', async manager => {
    const sources = manager.getRepository(SourceServiceAssetEntity);
    const endpoints = manager.getRepository(EndpointDefinitionEntity);
    const verifiedSources = new Set<string>();
    for (const site of candidate.sites) {
      if (!verifiedSources.has(site.sourceServiceAssetId)) {
        if (!await sources.exist({ where: { id: site.sourceServiceAssetId } })) {
          throw new Error('asset_ownership_rejected');
        }
        verifiedSources.add(site.sourceServiceAssetId);
      }
      for (const selector of site.endpoints) {
        const where = 'endpointDefinitionId' in selector
          ? { id: selector.endpointDefinitionId, sourceServiceAssetId: site.sourceServiceAssetId }
          : { sourceServiceAssetId: site.sourceServiceAssetId, method: selector.method, path: selector.path };
        if (!await endpoints.exist({ where })) throw new Error('asset_ownership_rejected');
      }
    }
  });
}
