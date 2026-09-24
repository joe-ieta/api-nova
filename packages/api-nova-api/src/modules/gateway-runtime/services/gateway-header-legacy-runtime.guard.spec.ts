import { DataSource } from 'typeorm';
import { GatewayRouteBindingEntity, GatewayRouteBindingStatus } from '../../../database/entities/gateway-route-binding.entity';
import { GatewayHeaderLegacyExceptionService } from './gateway-header-legacy-exception.service';
import { GatewayHeaderLegacyRuntimeGuard } from './gateway-header-legacy-runtime.guard';

describe('independent pre-cache Legacy runtime guard', () => {
  let db: DataSource, now: number, snapshot: any, id: string, state: boolean | undefined;
  const grant = () => ({ version: 1, mode: 'legacy', routeId: snapshot.routeBinding.id, owner: 'owner', reason: 'migration', issuedAt: '2026-09-24T00:00:00Z', expiresAt: '2026-10-24T00:00:00Z', rollbackEvidence: 'change:123' });
  const service = () => new GatewayHeaderLegacyExceptionService(db, () => now);
  const guard = () => new GatewayHeaderLegacyRuntimeGuard(db, () => state, () => now);
  beforeEach(async () => {
    now = Date.parse('2026-09-24T00:00:00Z'); state = false;
    db = await new DataSource({ type: 'sqljs', entities: [GatewayRouteBindingEntity], synchronize: true }).initialize();
    const repo = db.getRepository(GatewayRouteBindingEntity);
    const route = await repo.save(repo.create({ endpointDefinitionId: 'endpoint', runtimeAssetEndpointBindingId: 'membership', routePath: '/old', routeMethod: 'GET', upstreamPath: '/old', upstreamMethod: 'GET', routeVisibility: 'internal', authPolicyRef: 'jwt-default', status: GatewayRouteBindingStatus.ACTIVE }));
    snapshot = { routeBinding: JSON.parse(JSON.stringify(route)) };
    id = await service().register(route.id, grant(), { actorId: 'admin', source: { source: 'inline' }, registryConfigured: false });
  });
  afterEach(async () => { if (db.isInitialized) await db.destroy(); });
  async function reopen() { const database = (db.driver as any).export(); await db.destroy(); db = await new DataSource({ type: 'sqljs', database, entities: [GatewayRouteBindingEntity], synchronize: false }).initialize(); }
  it('checks a fresh persisted inline grant with an unchanged active snapshot after cold reopen', async () => {
    await reopen(); await expect(guard().assertAllowed(snapshot)).resolves.toBeUndefined();
  });
  it.each(['expired', 'revoked', 'unknown-provider', 'provider-enabled', 'source-change', 'policy-change', 'grant-deleted', 'all-metadata-deleted', 'unknown-field'])('fails closed before cache for %s without changing active snapshot', async failure => {
    if (failure === 'expired') now = Date.parse('2026-10-24T00:00:00Z');
    if (failure === 'revoked') await service().revoke(snapshot.routeBinding.id, id, 'admin');
    if (failure === 'unknown-provider') state = undefined;
    if (failure === 'provider-enabled') state = true;
    const repo = db.getRepository(GatewayRouteBindingEntity), current = await repo.findOneByOrFail({ id: snapshot.routeBinding.id });
    if (failure === 'source-change') (current.upstreamConfig!.headerPolicyLegacyException as any).source = { source: 'registry' };
    if (failure === 'policy-change') current.upstreamPath = '/changed';
    if (failure === 'all-metadata-deleted') current.upstreamConfig = {};
    if (failure === 'grant-deleted') delete current.upstreamConfig!.headerPolicyMigration;
    if (failure === 'unknown-field') (current.upstreamConfig!.headerPolicyLegacyException as any).unknown = true;
    await repo.save(current); await reopen();
    await expect(guard().assertAllowed(snapshot)).rejects.toMatchObject({ status: 503, message: 'gateway_header_legacy_exception_unavailable' });
    expect(snapshot.routeBinding.upstreamConfig).toBeNull();
  });
  it('cannot delete a marker already present in the published snapshot to regain legacy', async () => {
    snapshot.routeBinding = JSON.parse(JSON.stringify(await db.getRepository(GatewayRouteBindingEntity).findOneByOrFail({ id: snapshot.routeBinding.id })));
    await db.getRepository(GatewayRouteBindingEntity).update(snapshot.routeBinding.id, { upstreamConfig: {} });
    await expect(guard().assertAllowed(snapshot)).rejects.toMatchObject({ status: 503 });
  });
  it('refuses even a valid Registry grant until a trusted live provenance bridge exists', async () => {
    await db.getRepository(GatewayRouteBindingEntity).update(snapshot.routeBinding.id, { upstreamConfig: {} });
    state = true;
    const context = { actorId: 'admin', registryConfigured: true, source: { source: 'registry' as const, providerId: 'provider', siteId: 'site', providerFingerprint: 'a'.repeat(64) } };
    const registryId = await service().register(snapshot.routeBinding.id, grant(), context);
    await service().validate(snapshot.routeBinding.id, registryId, context);
    await expect(guard().assertAllowed(snapshot)).rejects.toMatchObject({ status: 503 });
  });
  it('rejects missing route instead of serving a stale active route', async () => {
    await db.getRepository(GatewayRouteBindingEntity).delete(snapshot.routeBinding.id);
    await expect(guard().assertAllowed(snapshot)).rejects.toMatchObject({ status: 503 });
  });
});
