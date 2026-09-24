import { UpstreamCredentialRegistry } from 'api-nova-parser';
import { requireGatewayRegistryHeaderV1 } from './gateway-header-v1-readiness';
import { createGatewayUpstreamCredentialResolver } from './gateway-upstream-credential-resolver';
const migration = () => ({ version: 1, mode: 'v1', source: 'registry' });
describe('H11A trusted host Registry and persisted route readiness', () => {
  let registry: UpstreamCredentialRegistry, route: any;
  beforeEach(async () => {
    registry = new UpstreamCredentialRegistry({ environment: 'test' });
    await registry.reload({ apiVersion: 'security.apinova.io/v1', kind: 'UpstreamCredentialBindings', metadata: { revision: 'r1', environment: 'test' }, reload: { mode: 'manual', debounceMs: 0, rejectPlaintextSecrets: true }, secretProviders: {}, credentials: {}, sites: [{ id: 'site', sourceServiceAssetId: 'source', match: { scheme: 'http', host: '127.0.0.1', port: 80, basePath: '/' }, allowedHosts: ['127.0.0.1'], credential: 'none', headerPolicy: { version: 1 }, endpoints: [{ endpointDefinitionId: 'endpoint' }] }] });
    route = { id: 'route', endpointDefinitionId: 'endpoint', upstreamConfig: { headerPolicyMigration: migration() } };
  });
  it('requires a successfully compiled policy from exactly one explicit Endpoint binding', () => {
    expect(requireGatewayRegistryHeaderV1(route, registry.captureSnapshot()).identity).toBeTruthy();
  });
  it.each(['missing', 'legacy', 'inline', 'unknown', 'inline-conflict', 'legacy-exception', 'wrong-endpoint', 'unready'])('rejects %s without a provider lookup', failure => {
    if (failure === 'missing') delete route.upstreamConfig.headerPolicyMigration;
    if (failure === 'legacy') route.upstreamConfig.headerPolicyMigration.mode = 'legacy';
    if (failure === 'inline') route.upstreamConfig.headerPolicyMigration.source = 'inline';
    if (failure === 'unknown') route.upstreamConfig.headerPolicyMigration.unknown = true;
    if (failure === 'inline-conflict') route.upstreamConfig.headerPolicy = { version: 1 };
    if (failure === 'legacy-exception') route.upstreamConfig.headerPolicyLegacyException = {};
    if (failure === 'wrong-endpoint') route.endpointDefinitionId = 'other';
    expect(() => requireGatewayRegistryHeaderV1(route, failure === 'unready' ? undefined : registry.captureSnapshot())).toThrow('NOT_READY');
  });
  it('production resolver checks the persisted marker before resolving any credentials', async () => {
    const snapshot = registry.captureSnapshot(), spy = jest.fn(snapshot.resolveSecret);
    const adapter = createGatewayUpstreamCredentialResolver(() => ({ ...snapshot, resolveSecret: spy }), { enableHeaderPolicy: true, requirePersistedV1: true });
    delete route.upstreamConfig.headerPolicyMigration;
    await expect(adapter.resolve({ routeBinding: route } as any, 'http://127.0.0.1/items')).rejects.toThrow('NOT_READY');
    expect(spy).not.toHaveBeenCalled();
  });
});
