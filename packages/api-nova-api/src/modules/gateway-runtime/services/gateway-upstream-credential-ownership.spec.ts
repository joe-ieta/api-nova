import { DataSource } from 'typeorm';
import { validateUpstreamCredentialBindings } from 'api-nova-parser';
import { SourceServiceAssetEntity } from '../../../database/entities/source-service-asset.entity';
import { EndpointDefinitionEntity } from '../../../database/entities/endpoint-definition.entity';
import { validateGatewayCredentialOwnership } from './gateway-upstream-credential-ownership';

describe('Credential endpoint scope database ownership', () => {
  let db: DataSource;
  beforeEach(async () => {
    db = await new DataSource({ type: 'sqljs', entities: [SourceServiceAssetEntity, EndpointDefinitionEntity], synchronize: true }).initialize();
    for (const id of ['a', 'b', 'c']) {
      await db.getRepository(SourceServiceAssetEntity).save({ id, sourceKey: id });
      await db.getRepository(EndpointDefinitionEntity).save({ id: `e-${id}`, sourceServiceAssetId: id, method: 'GET', path: '/items' });
    }
  });
  afterEach(async () => { await db.destroy(); });
  function candidate(scope: string[], sources: string[] = ['a'], referenced = true) {
    return validateUpstreamCredentialBindings({ apiVersion: 'security.apinova.io/v1', kind: 'UpstreamCredentialBindings', metadata: { revision: 'r1', environment: 'test' }, reload: { mode: 'manual', debounceMs: 0, rejectPlaintextSecrets: true }, secretProviders: { env: { type: 'env' } },
      credentials: { token: { type: 'basic', usernameRef: 'env:USER', passwordRef: 'env:PASS', endpointDefinitionIds: scope } },
      sites: sources.map(source => ({ id: source, sourceServiceAssetId: source, match: { scheme: 'https', host: `${source}.example`, port: 443, basePath: '/' }, allowedHosts: [`${source}.example`], credential: referenced ? 'token' : 'none', endpoints: [{ endpointDefinitionId: `e-${source}` }] })) });
  }
  it('accepts same-source scope', async () => { await expect(validateGatewayCredentialOwnership(db, candidate(['e-a']))).resolves.toBeUndefined(); });
  it('rejects nonexistent scope even if Site selectors are valid', async () => { await expect(validateGatewayCredentialOwnership(db, candidate(['missing']))).rejects.toThrow('asset_ownership_rejected'); });
  it('rejects scope belonging exclusively to an unreferenced source', async () => { await expect(validateGatewayCredentialOwnership(db, candidate(['e-c']))).rejects.toThrow('asset_ownership_rejected'); });
  it('accepts union of explicit source references without requiring every ID in every source', async () => { await expect(validateGatewayCredentialOwnership(db, candidate(['e-a', 'e-b'], ['a', 'b']))).resolves.toBeUndefined(); });
  it('checks unreferenced presets exist, then validates ownership when binding activates', async () => {
    await expect(validateGatewayCredentialOwnership(db, candidate(['e-c'], ['a'], false))).resolves.toBeUndefined();
    await expect(validateGatewayCredentialOwnership(db, candidate(['e-c'], ['a'], true))).rejects.toThrow('asset_ownership_rejected');
    await expect(validateGatewayCredentialOwnership(db, candidate(['missing'], ['a'], false))).rejects.toThrow('asset_ownership_rejected');
  });
  it('rechecks current database ownership rather than trusting a previously approved scope', async () => {
    const value = candidate(['e-a']); await validateGatewayCredentialOwnership(db, value);
    await db.getRepository(EndpointDefinitionEntity).update('e-a', { sourceServiceAssetId: 'c', path: '/moved' });
    await expect(validateGatewayCredentialOwnership(db, value)).rejects.toThrow('asset_ownership_rejected');
  });
});
