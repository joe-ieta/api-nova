import { DataSource } from 'typeorm';
import { GatewayRouteBindingEntity, GatewayRouteBindingStatus } from '../../../database/entities/gateway-route-binding.entity';
import { GatewayHeaderLegacyExceptionService, GatewayLegacyExceptionContext } from './gateway-header-legacy-exception.service';
import { newGatewayHeaderPolicyDraft } from './gateway-header-migration';

describe('durable named Legacy Header exception (no activation)', () => {
  let db: DataSource, now: number, id: string;
  const context: GatewayLegacyExceptionContext = { actorId: 'admin', registryConfigured: true,
    source: { source: 'registry', providerId: 'provider', siteId: 'site', providerFingerprint: 'a'.repeat(64) } };
  const service = () => new GatewayHeaderLegacyExceptionService(db, () => now);
  const grant = () => ({ version: 1, mode: 'legacy', routeId: id, owner: 'owner', reason: 'cookie migration', issuedAt: '2026-09-24T00:00:00Z', expiresAt: '2026-10-24T00:00:00Z', rollbackEvidence: 'change:123' });
  beforeEach(async () => {
    now = Date.parse('2026-09-24T00:00:00Z');
    db = await new DataSource({ type: 'sqljs', entities: [GatewayRouteBindingEntity], synchronize: true }).initialize();
    const repo = db.getRepository(GatewayRouteBindingEntity);
    id = (await repo.save(repo.create({ endpointDefinitionId: 'endpoint', runtimeAssetEndpointBindingId: 'membership', routePath: '/old', routeMethod: 'GET', upstreamPath: '/old', upstreamMethod: 'GET', authPolicyRef: 'jwt-default', routeVisibility: 'internal', status: GatewayRouteBindingStatus.DRAFT, upstreamConfig: { preserveHost: true } }))).id;
  });
  afterEach(async () => { if (db.isInitialized) await db.destroy(); });
  async function reopen() { const database = (db.driver as any).export(); await db.destroy(); db = await new DataSource({ type: 'sqljs', database, entities: [GatewayRouteBindingEntity], synchronize: false }).initialize(); }
  it('binds route/Endpoint/source/content, survives cold reopen and never activates', async () => {
    const exceptionId = await service().register(id, grant(), context);
    await reopen(); await expect(service().validate(id, exceptionId, context)).resolves.toBeUndefined();
    const route = await db.getRepository(GatewayRouteBindingEntity).findOneByOrFail({ id });
    expect(route.status).toBe(GatewayRouteBindingStatus.DRAFT);
    expect(route.upstreamConfig?.headerPolicyLegacyException).toMatchObject({ id: exceptionId, routeId: id, endpointDefinitionId: 'endpoint', source: context.source, grant: grant(), policyFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) });
  });
  it('expiry is absolute across restarts and cannot silently renew or register again', async () => {
    const exceptionId = await service().register(id, grant(), context); await reopen();
    now = Date.parse('2026-10-24T00:00:00Z');
    await expect(service().validate(id, exceptionId, context)).rejects.toThrow();
    await expect(service().register(id, { ...grant(), issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + 86400000).toISOString() }, context)).rejects.toThrow();
    expect((await db.getRepository(GatewayRouteBindingEntity).findOneByOrFail({ id })).upstreamConfig?.headerPolicyMigration).toEqual(grant());
  });
  it('persists a revocation tombstone and rejects replay after cold reopen', async () => {
    const exceptionId = await service().register(id, grant(), context);
    await service().revoke(id, exceptionId, 'revoker'); await reopen();
    await expect(service().validate(id, exceptionId, context)).rejects.toThrow();
    await expect(service().register(id, grant(), context)).rejects.toThrow();
    await expect(service().revoke(id, exceptionId, 'revoker')).resolves.toBeUndefined();
    const route = await db.getRepository(GatewayRouteBindingEntity).findOneByOrFail({ id });
    expect(route.upstreamConfig?.headerPolicyMigration).toEqual(grant());
    expect(route.upstreamConfig?.headerPolicyLegacyException).toMatchObject({ status: 'revoked', revokedBy: 'revoker', revokedAt: new Date(now).toISOString() });
  });
  it.each(['disabled', 'site', 'provider', 'fingerprint', 'source'])('rejects changed provider context %s without falling back', async change => {
    const exceptionId = await service().register(id, grant(), context); await reopen();
    const next: any = JSON.parse(JSON.stringify(context));
    if (change === 'disabled') next.registryConfigured = false;
    if (change === 'site') next.source.siteId = 'other';
    if (change === 'provider') next.source.providerId = 'other';
    if (change === 'fingerprint') next.source.providerFingerprint = 'b'.repeat(64);
    if (change === 'source') { next.source = { source: 'inline' }; next.registryConfigured = false; }
    await expect(service().validate(id, exceptionId, next)).rejects.toThrow();
  });
  it.each(['endpoint', 'policy', 'deleted-migration', 'unknown-field', 'expiry-rewritten'])('rejects persisted binding change %s', async change => {
    const exceptionId = await service().register(id, grant(), context);
    const repo = db.getRepository(GatewayRouteBindingEntity), row = await repo.findOneByOrFail({ id });
    if (change === 'endpoint') row.endpointDefinitionId = 'other';
    if (change === 'policy') row.upstreamConfig!.preserveHost = false;
    if (change === 'deleted-migration') delete row.upstreamConfig!.headerPolicyMigration;
    if (change === 'expiry-rewritten') { (row.upstreamConfig!.headerPolicyMigration as any).expiresAt = '2026-10-01T00:00:00Z'; (row.upstreamConfig!.headerPolicyLegacyException as any).grant.expiresAt = '2026-10-01T00:00:00Z'; }
    if (change === 'unknown-field') (row.upstreamConfig!.headerPolicyLegacyException as any).unknown = true;
    await repo.save(row); await reopen();
    await expect(service().validate(id, exceptionId, context)).rejects.toThrow();
  });
  it('rejects downgrade of v1, wrong-route grants and unknown fields without writes', async () => {
    await expect(service().register(id, { ...grant(), routeId: 'other' }, context)).rejects.toThrow();
    await expect(service().register(id, { ...grant(), unknown: true }, context)).rejects.toThrow();
    await db.getRepository(GatewayRouteBindingEntity).update(id, { upstreamConfig: newGatewayHeaderPolicyDraft() });
    await expect(service().register(id, grant(), context)).rejects.toThrow();
    expect((await db.getRepository(GatewayRouteBindingEntity).findOneByOrFail({ id })).upstreamConfig).toEqual(newGatewayHeaderPolicyDraft());
  });
  it('permits exactly one concurrent registration; a stale writer cannot replace the winner', async () => {
    const results = await Promise.allSettled([service().register(id, grant(), context), service().register(id, grant(), context)]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
  });
});
