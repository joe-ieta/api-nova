import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { createNetworkPolicyCompiler } from 'api-nova-parser';
import { GatewayRouteSnapshotEntity } from '../../../database/entities/gateway-route-snapshot.entity';
import { RuntimeAssetEntity, RuntimeAssetStatus, RuntimeAssetType } from '../../../database/entities/runtime-asset.entity';
import { GatewayRoutePathMatchMode } from '../../../database/entities/gateway-route-binding.entity';
import { GatewayPolicyService } from './gateway-policy.service';
import { GatewayRouteSnapshotService } from './gateway-route-snapshot.service';
import { inspectGatewayActiveRouteCapture } from './gateway-active-route-capture';
import { createGatewayNetworkRegistrationBundle, inspectGatewayNetworkRegistrationBundle, closeGatewayNetworkRegistrationBundle } from './gateway-network-registration-coordinator';

// Positive branded-host assembly is exercised against real PostgreSQL by the isolated worker.
// SQL.js must not be dressed up as a PostgreSQL host to obtain a registry capability.
describe('registration coordinator SQL.js route boundaries', () => {
  let db: DataSource, service: GatewayRouteSnapshotService;
  const assetId = '00000000-0000-0000-0000-000000000001';
  beforeEach(async () => {
    db = await new DataSource({ type: 'sqljs', entities: [GatewayRouteSnapshotEntity, RuntimeAssetEntity], synchronize: true }).initialize();
    const runtimeAsset = await db.getRepository(RuntimeAssetEntity).save({ id: assetId, name: 'coord', type: RuntimeAssetType.GATEWAY_SERVICE, status: RuntimeAssetStatus.ACTIVE });
    service = new GatewayRouteSnapshotService(new GatewayPolicyService(), {} as any, db.getRepository(GatewayRouteSnapshotEntity), {} as any, {} as any, db.getRepository(RuntimeAssetEntity), {} as any, {} as any, {} as any);
    const routeBinding = { id: 'route', authPolicyRef: 'jwt-default', pathMatchMode: GatewayRoutePathMatchMode.EXACT, upstreamMethod: 'GET', upstreamPath: '/items', createdAt: new Date(), updatedAt: new Date() };
    const entries = [{ runtimeAsset, routeBinding, membership: { id: 'member', publicationRevision: 1 }, publishBinding: { id: 'pub' }, sourceServiceAsset: { id: 'source' }, endpointDefinition: { id: 'endpoint' }, sourceServiceInstance: { id: 'instance' }, normalizedRoutePath: '/items', routeMethod: 'GET', upstreamBaseUrl: 'https://a.example', priorityScore: 1, policies: new GatewayPolicyService().compileForRoute(routeBinding as any) }];
    const fingerprint = (service as any).fingerprintEntries(entries);
    (service as any).candidateSnapshots.set('v1', { runtimeAssetId: assetId, entries, snapshotFingerprint: fingerprint, preparedAt: new Date() });
    await db.transaction(async manager => {
      await service.activateCandidate('v1', manager);
      await manager.update(RuntimeAssetEntity, assetId, { metadata: { activeRevision: 'v1', activeGatewaySnapshotFingerprint: fingerprint } });
    });
    await service.reload();
  });
  afterEach(async () => { service?.onModuleDestroy(); if (db?.isInitialized) await db.destroy(); });
  function rejectHost(capture = service.captureActiveRouteCatalog(service.readActiveRouteCatalog())) {
    const fake = { captureSnapshot: jest.fn(), consumeProof: jest.fn() };
    expect(() => createGatewayNetworkRegistrationBundle({ routes: service, capture, host: fake as any, compiler: createNetworkPolicyCompiler({ deniedDestinations: [], loopback: 'deny' }), policies: [], proofs: [] })).toThrow('gateway_host_credential_registry_unavailable');
    expect(fake.captureSnapshot).not.toHaveBeenCalled(); expect(fake.consumeProof).not.toHaveBeenCalled();
  }
  it('committed SQL.js capture is not sufficient to mint network registrations', () => { rejectHost(); });
  it('reload invalidates old captures and never repairs a forged host', async () => {
    const capture = service.captureActiveRouteCatalog(service.readActiveRouteCatalog());
    await service.reload(); expect(() => inspectGatewayActiveRouteCapture(capture)).toThrow('STALE'); rejectHost(capture);
  });
  it.each(['gateway_stopped', 'gateway_deleted'])('%s synchronously removes committed routes', reason => {
    const capture = service.captureActiveRouteCatalog(service.readActiveRouteCatalog());
    service.handleSnapshotRefreshRequested({ reason: `runtime_assets.${reason}`, runtimeAssetId: assetId });
    expect(service.readActiveRouteCatalog().routes).toEqual([]);
    expect(() => inspectGatewayActiveRouteCapture(capture)).toThrow('STALE'); rejectHost(capture);
  });
  it('bundle clones and structural signals cannot be inspected or closed', () => {
    const fake = Object.freeze({ kind: 'gateway-network-registration-bundle' as const, signal: new AbortController().signal });
    expect(() => inspectGatewayNetworkRegistrationBundle(fake)).toThrow('gateway_network_registration_unavailable');
    expect(() => closeGatewayNetworkRegistrationBundle(fake)).toThrow('gateway_network_registration_unavailable');
  });
});
