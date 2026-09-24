import { DataSource } from 'typeorm';
import { GatewayRouteBindingEntity, GatewayRoutePathMatchMode, GatewayRouteBindingStatus } from '../../../database/entities/gateway-route-binding.entity';
import { GatewayRouteSnapshotEntity } from '../../../database/entities/gateway-route-snapshot.entity';
import { RuntimeAssetEntity, RuntimeAssetType, RuntimeAssetStatus } from '../../../database/entities/runtime-asset.entity';
import { GatewayPolicyService } from './gateway-policy.service';
import { GatewayRouteSnapshotService } from './gateway-route-snapshot.service';
import { GatewayHeaderLegacyExceptionService } from './gateway-header-legacy-exception.service';
import { PublicationService } from '../../publication/services/publication.service';

describe('Header migration draft, Legacy record and verified snapshot joint persistence', () => {
  let db: DataSource, now: number;
  const entities = [GatewayRouteBindingEntity, GatewayRouteSnapshotEntity, RuntimeAssetEntity];
  const context = { actorId: 'admin', registryConfigured: true, source: { source: 'registry' as const, providerId: 'provider', siteId: 'site', providerFingerprint: 'a'.repeat(64) } };
  beforeEach(async () => { now = Date.parse('2026-09-24T00:00:00Z'); db = await new DataSource({ type: 'sqljs', entities, synchronize: true }).initialize(); });
  afterEach(async () => { if (db.isInitialized) await db.destroy(); });
  const legacy = () => new GatewayHeaderLegacyExceptionService(db, () => now);
  function snapshots() { return new GatewayRouteSnapshotService(new GatewayPolicyService(), db.getRepository(GatewayRouteBindingEntity), db.getRepository(GatewayRouteSnapshotEntity), {} as any, {} as any, db.getRepository(RuntimeAssetEntity), {} as any, {} as any, {} as any); }
  async function reopen() { const database = (db.driver as any).export(); await db.destroy(); db = await new DataSource({ type: 'sqljs', database, entities, synchronize: false }).initialize(); }
  async function seed() {
    const runtime = await db.getRepository(RuntimeAssetEntity).save({ id: '00000000-0000-0000-0000-000000000001', name: 'old', type: RuntimeAssetType.GATEWAY_SERVICE, status: RuntimeAssetStatus.ACTIVE });
    const repo = db.getRepository(GatewayRouteBindingEntity);
    const route = await repo.save(repo.create({ endpointDefinitionId: 'endpoint', runtimeAssetEndpointBindingId: 'membership', routePath: '/old', routeMethod: 'GET', upstreamPath: '/old', upstreamMethod: 'GET', authPolicyRef: 'jwt-default', status: GatewayRouteBindingStatus.ACTIVE, routeVisibility: 'internal', pathMatchMode: GatewayRoutePathMatchMode.EXACT }));
    const entries = [{ runtimeAsset: runtime, membership: { id: 'membership', publicationRevision: 1 }, publishBinding: { id: 'publication' }, endpointDefinition: { id: 'endpoint' }, routeBinding: route, sourceServiceInstance: { id: 'source' }, normalizedRoutePath: '/old', routeMethod: 'GET', upstreamBaseUrl: 'http://127.0.0.1:1', policies: new GatewayPolicyService().compileForRoute(route) }];
    const fingerprint = (snapshots() as any).fingerprintEntries(entries);
    await db.getRepository(RuntimeAssetEntity).update(runtime.id, { metadata: { activeRevision: 'verified', activeGatewaySnapshotFingerprint: fingerprint } });
    const snapshot = await db.getRepository(GatewayRouteSnapshotEntity).save({ runtimeAssetId: runtime.id, revision: 'verified', fingerprint, routeCount: 1, payload: JSON.parse(JSON.stringify(entries)), activatedAt: new Date() });
    const grant = { version: 1, mode: 'legacy', routeId: route.id, owner: 'owner', reason: 'migration', issuedAt: '2026-09-24T00:00:00Z', expiresAt: '2026-10-24T00:00:00Z', rollbackEvidence: 'review:123' };
    const exceptionId = await legacy().register(route.id, grant, context);
    return { runtime, route, snapshot, exceptionId };
  }
  it('persists a new v1 draft alongside a named old exception without changing the verified snapshot', async () => {
    const fixture = await seed();
    const service: any = Object.create(PublicationService.prototype);
    Object.assign(service, { routeBindingRepository: db.getRepository(GatewayRouteBindingEntity), extractPrimaryEndpoint: () => ({ path: '/new', method: 'GET' }), ensureRouteConflictFree: jest.fn(), recordAuditEvent: jest.fn() });
    const draft = await service.ensureDefaultGatewayRoute({ membership: { id: 'new-membership' }, runtimeAsset: fixture.runtime, endpointDefinition: { id: 'new-endpoint' }, sourceServiceAsset: { id: 'source' } });
    await reopen();
    const persisted = await db.getRepository(GatewayRouteBindingEntity).findOneByOrFail({ id: draft.id });
    expect(persisted.status).toBe('draft'); expect(persisted.upstreamConfig?.headerPolicy).toEqual({ version: 1 });
    expect(() => new GatewayPolicyService().compileForRoute(persisted)).toThrow('NOT_READY');
    await legacy().validate(fixture.route.id, fixture.exceptionId, context);
    const restored = snapshots(); await restored.onModuleInit();
    expect(restored.resolve('localhost', 'GET', '/old')?.routeBinding.id).toBe(fixture.route.id);
    expect(restored.resolve('localhost', 'GET', '/new')).toBeNull();
    expect((await db.getRepository(GatewayRouteSnapshotEntity).findOneByOrFail({ id: fixture.snapshot.id })).fingerprint).toBe(fixture.snapshot.fingerprint);
  });
  it.each(['unknown', 'deleted-policy', 'provider-closed', 'expired', 'revoked'])('rejects exception %s while a bad migration retains the last verified snapshot', async failure => {
    const fixture = await seed(); await reopen(); const current = snapshots(); await current.onModuleInit();
    const repository = db.getRepository(GatewayRouteBindingEntity);
    const route = await repository.findOneByOrFail({ id: fixture.route.id });
    if (failure === 'unknown') { (route.upstreamConfig!.headerPolicyLegacyException as any).unknown = true; await repository.save(route); }
    if (failure === 'deleted-policy') { delete route.upstreamConfig!.headerPolicyMigration; await repository.save(route); }
    if (failure === 'expired') now = Date.parse('2026-10-24T00:00:00Z');
    if (failure === 'revoked') await legacy().revoke(route.id, fixture.exceptionId, 'admin');
    const checkContext = failure === 'provider-closed' ? { ...context, registryConfigured: false } : context;
    await expect(legacy().validate(route.id, fixture.exceptionId, checkContext)).rejects.toThrow();
    // A candidate that bypasses the publication gate is still refused by snapshot validation.
    const invalid = JSON.parse(JSON.stringify(fixture.snapshot.payload));
    invalid[0].routeBinding.upstreamConfig = { headerPolicy: { version: 1 } };
    await db.getRepository(GatewayRouteSnapshotEntity).update(fixture.snapshot.id, { payload: invalid });
    await expect(current.reload()).rejects.toThrow('GATEWAY_ACTIVE_SNAPSHOT_INVALID');
    expect(current.resolve('localhost', 'GET', '/old')?.routeBinding.id).toBe(fixture.route.id);
    await reopen(); await expect(snapshots().onModuleInit()).rejects.toThrow('GATEWAY_ACTIVE_SNAPSHOT_INVALID');
    await expect(legacy().validate(route.id, fixture.exceptionId, checkContext)).rejects.toThrow();
  });
});
