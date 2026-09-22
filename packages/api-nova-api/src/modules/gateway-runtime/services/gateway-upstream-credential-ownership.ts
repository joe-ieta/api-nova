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
    const credentialSources = new Map<string, Set<string>>();
    for (const site of candidate.sites) {
      for (const selection of [site.credential, ...site.endpoints.map(endpoint => endpoint.credential)]) {
        if (selection.mode !== 'reference') continue;
        const owners = credentialSources.get(selection.credentialId) ?? new Set<string>();
        owners.add(site.sourceServiceAssetId); credentialSources.set(selection.credentialId, owners);
      }
    }
    for (const [id, credential] of Object.entries(candidate.credentials)) {
      const owners = credentialSources.get(id);
      for (const endpointId of credential.endpointDefinitionIds ?? []) {
        const endpoint = await endpoints.findOne({ where: { id: endpointId }, select: { id: true, sourceServiceAssetId: true } });
        // Unreferenced presets require existing IDs; binding later establishes the source intersection.
        if (!endpoint || (owners?.size && !owners.has(endpoint.sourceServiceAssetId))) throw new Error('asset_ownership_rejected');
      }
    }
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
