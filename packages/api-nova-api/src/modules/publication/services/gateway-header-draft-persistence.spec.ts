import { DataSource } from 'typeorm';
import { PublicationService } from './publication.service';
import { GatewayRouteBindingEntity, GatewayRouteBindingStatus } from '../../../database/entities/gateway-route-binding.entity';
import { GatewayRouteSnapshotEntity } from '../../../database/entities/gateway-route-snapshot.entity';
import { RuntimeAssetType } from '../../../database/entities/runtime-asset.entity';
import { GatewayPolicyService } from '../../gateway-runtime/services/gateway-policy.service';

describe('new Gateway draft Header policy durable defaults', () => {
  let db: DataSource;
  const entities = [GatewayRouteBindingEntity, GatewayRouteSnapshotEntity];
  beforeEach(async () => { db = await new DataSource({ type: 'sqljs', entities, synchronize: true }).initialize(); });
  afterEach(async () => { if (db?.isInitialized) await db.destroy(); });
  function setup(id: string) {
    const context = { membership: { id }, runtimeAsset: { id: 'runtime', type: RuntimeAssetType.GATEWAY_SERVICE }, endpointDefinition: { id: 'endpoint-' + id }, sourceServiceAsset: { id: 'source' } };
    const service: any = Object.create(PublicationService.prototype);
    const repo = db.getRepository(GatewayRouteBindingEntity);
    Object.assign(service, { routeBindingRepository: repo,
      resolveMembershipPublicationContext: async () => context,
      extractPrimaryEndpoint: () => ({ path: '/' + id, method: 'GET' }),
      ensureRouteConflictFree: jest.fn(), recordAuditEvent: jest.fn(), emitGatewaySnapshotRefresh: jest.fn(), buildMembershipPublicationState: jest.fn(),
    });
    return { service, context, repo };
  }
  async function reopen() {
    const database = (db.driver as any).export(); await db.destroy();
    db = await new DataSource({ type: 'sqljs', database, entities, synchronize: false }).initialize();
  }
  it.each(['configured', 'automatic'])('persists only a new %s draft, surviving reopen while activation stays gated', async kind => {
    const { service, context, repo } = setup(kind);
    if (kind === 'configured') await service.configureRuntimeMembershipGatewayRoute(kind, { upstreamConfig: { cache: { ttlMs: 25 } } });
    else await service.ensureDefaultGatewayRoute(context);
    const before = await repo.findOneByOrFail({ runtimeAssetEndpointBindingId: kind });
    expect(before.status).toBe(GatewayRouteBindingStatus.DRAFT);
    expect(before.upstreamConfig).toMatchObject({ headerPolicy: { version: 1 }, headerPolicyMigration: { version: 1, mode: 'v1', source: 'inline' } });
    await reopen(); const after = await db.getRepository(GatewayRouteBindingEntity).findOneByOrFail({ id: before.id });
    expect(after.upstreamConfig).toEqual(before.upstreamConfig);
    expect(after.status).toBe(GatewayRouteBindingStatus.DRAFT);
    expect(() => new GatewayPolicyService().compileForRoute(after)).toThrow('NOT_READY');
    const configured = setup(kind).service;
    await expect(configured.configureRuntimeMembershipGatewayRoute(kind, { upstreamConfig: {} })).rejects.toMatchObject({ response: { code: 'GATEWAY_HEADER_POLICY_NOT_READY' } });
    expect((await db.getRepository(GatewayRouteBindingEntity).findOneByOrFail({ id: before.id })).upstreamConfig).toEqual(before.upstreamConfig);
  });
  it('leaves an old route unmarked and its persisted verified snapshot untouched', async () => {
    const { service, repo } = setup('old');
    const old = await repo.save(repo.create({ endpointDefinitionId: 'endpoint-old', runtimeAssetEndpointBindingId: 'old', routePath: '/old', routeMethod: 'GET', upstreamPath: '/old', upstreamMethod: 'GET', routeVisibility: 'internal', authPolicyRef: 'jwt-default', status: GatewayRouteBindingStatus.ACTIVE, upstreamConfig: { cache: { ttlMs: 5 } } }));
    const snapshots = db.getRepository(GatewayRouteSnapshotEntity);
    const snapshot = await snapshots.save(snapshots.create({ runtimeAssetId: 'runtime', revision: 'verified-old', fingerprint: 'f'.repeat(64), routeCount: 1, payload: [{ routeBinding: old }], activatedAt: new Date() }));
    const serialized = JSON.stringify(snapshot);
    await service.configureRuntimeMembershipGatewayRoute('old', { upstreamConfig: { cache: { ttlMs: 25 } } });
    await reopen();
    const after = await db.getRepository(GatewayRouteBindingEntity).findOneByOrFail({ id: old.id });
    expect(after.upstreamConfig).toEqual({ cache: { ttlMs: 25 } });
    expect(JSON.parse(JSON.stringify(await db.getRepository(GatewayRouteSnapshotEntity).findOneByOrFail({ id: snapshot.id })))).toEqual(JSON.parse(serialized));
  });
  it('rejects publication before ACTIVE writes even when auto-configuration creates a new draft', async () => {
    const { service, context, repo } = setup('publishing');
    Object.assign(service, { ensureProfile: async () => ({}), buildReadiness: () => ({ ready: true, reasons: [] }), profileRepository: { save: jest.fn() }, bindingRepository: { save: jest.fn() } });
    await expect(service.publishMembershipContext(context, true)).rejects.toMatchObject({ response: { code: 'GATEWAY_HEADER_POLICY_NOT_READY' } });
    expect(service.profileRepository.save).not.toHaveBeenCalled(); expect(service.bindingRepository.save).not.toHaveBeenCalled();
    expect((await repo.findOneByOrFail({ runtimeAssetEndpointBindingId: 'publishing' })).status).toBe(GatewayRouteBindingStatus.DRAFT);
  });
});
