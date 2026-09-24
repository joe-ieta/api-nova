import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { GatewayRouteSnapshotEntity } from '../../../database/entities/gateway-route-snapshot.entity';
import { RuntimeAssetEntity, RuntimeAssetStatus, RuntimeAssetType } from '../../../database/entities/runtime-asset.entity';
import { GatewayRoutePathMatchMode } from '../../../database/entities/gateway-route-binding.entity';
import { GatewayPolicyService } from './gateway-policy.service';
import { GatewayRouteSnapshotService } from './gateway-route-snapshot.service';
import { GatewayActiveRouteCatalogEvent } from './gateway-active-route-catalog';

const assetId = '00000000-0000-0000-0000-000000000001';
const entities = [GatewayRouteSnapshotEntity, RuntimeAssetEntity];
describe('committed Gateway active route catalog (SQL.js)', () => {
  let db: DataSource;
  let service: GatewayRouteSnapshotService;
  let events: GatewayActiveRouteCatalogEvent[];
  const createService = () => new GatewayRouteSnapshotService(new GatewayPolicyService(), {} as any,
    db.getRepository(GatewayRouteSnapshotEntity), {} as any, {} as any,
    db.getRepository(RuntimeAssetEntity), {} as any, {} as any, {} as any);
  const stage = async (revision: string) => {
    const runtimeAsset = await db.getRepository(RuntimeAssetEntity).findOneByOrFail({ id: assetId });
    const routeBinding = { id: 'route-1', authPolicyRef: 'jwt-default',
      pathMatchMode: GatewayRoutePathMatchMode.EXACT, upstreamPath: '/fixture', upstreamMethod: 'GET',
      createdAt: new Date(), updatedAt: new Date() };
    const entries = [{ runtimeAsset, routeBinding,
      membership: { id: 'member-1', publicationRevision: 1 }, publishBinding: { id: 'pub-1' },
      sourceServiceInstance: { id: 'source-1' }, normalizedRoutePath: '/fixture', routeMethod: 'GET',
      upstreamBaseUrl: 'http://127.0.0.1:1', priorityScore: 1,
      policies: new GatewayPolicyService().compileForRoute(routeBinding as any) }];
    const fingerprint = (service as any).fingerprintEntries(entries);
    (service as any).candidateSnapshots.set(revision, { runtimeAssetId: assetId, entries,
      snapshotFingerprint: fingerprint, preparedAt: new Date() });
    return fingerprint;
  };
  const commit = async (revision: string) => {
    const fingerprint = await stage(revision);
    await db.transaction(async manager => {
      await service.activateCandidate(revision, manager);
      await manager.update(RuntimeAssetEntity, assetId, { metadata: {
        activeRevision: revision, activeGatewaySnapshotFingerprint: fingerprint,
      } });
    });
  };
  beforeEach(async () => {
    db = await new DataSource({ type: 'sqljs', entities, synchronize: true }).initialize();
    await db.getRepository(RuntimeAssetEntity).save({ id: assetId, name: 'catalog-fixture',
      type: RuntimeAssetType.GATEWAY_SERVICE, status: RuntimeAssetStatus.ACTIVE });
    service = createService(); events = [];
    service.observeActiveRouteCatalog(event => { events.push(event); });
  });
  afterEach(async () => { service.onModuleDestroy(); if (db.isInitialized) await db.destroy(); });

  it('publishes only after commit then explicit reload, with fixed immutable fields', async () => {
    expect(() => service.readActiveRouteCatalog()).toThrow('NOT_READY');
    await commit('v1');
    expect(events).toHaveLength(0);
    await service.reload();
    expect(events).toHaveLength(1);
    expect(Object.keys(events[0].snapshot.routes[0]).sort()).toEqual([
      'fingerprint', 'revision', 'routeBindingId', 'runtimeAssetId']);
    expect(events[0].snapshot.routes[0].revision).toBe('v1');
    expect(Object.isFrozen(events[0].snapshot.routes[0])).toBe(true);
    expect(JSON.stringify(events)).not.toContain('127.0.0.1');
  });

  it.each(['commit', 'rollback'])('refuses shared active transaction without owning it (%s)', async outcome => {
    await commit('v1'); await service.reload();
    const previous = service.readActiveRouteCatalog();
    const fingerprint = await stage('v2');
    const runner = db.createQueryRunner(); await runner.startTransaction();
    await service.activateCandidate('v2', runner.manager);
    await runner.manager.update(RuntimeAssetEntity, assetId, { metadata: {
      activeRevision: 'v2', activeGatewaySnapshotFingerprint: fingerprint,
    } });
    const routingBefore = (service as any).snapshot;
    await expect(service.reload()).rejects.toThrow('GATEWAY_SNAPSHOT_TRANSACTION_PENDING');
    expect(runner.isTransactionActive).toBe(true);
    expect(service.readActiveRouteCatalog()).toBe(previous);
    expect((service as any).snapshot).toBe(routingBefore);
    expect(events).toHaveLength(1);
    if (outcome === 'commit') await runner.commitTransaction();
    else { await runner.rollbackTransaction(); service.rollbackRuntimeAsset(assetId); }
    await runner.release();
    expect(events).toHaveLength(1);
    await service.reload();
    expect(service.readActiveRouteCatalog().routes[0].revision).toBe(outcome === 'commit' ? 'v2' : 'v1');
  });

  it('isolates a transaction started after synchronous SQL.js capture', async () => {
    await commit('v1'); await service.reload();
    const previous = service.readActiveRouteCatalog();
    const fingerprint = await stage('v2');
    const runner = db.createQueryRunner();
    const original = DataSource.prototype.initialize;
    let release!: () => void; let entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    const initialize = jest.spyOn(DataSource.prototype, 'initialize').mockImplementationOnce(async function (this: DataSource) {
      entered(); await held; return original.call(this);
    });
    const pending = service.reload(); await ready;
    await runner.startTransaction();
    await service.activateCandidate('v2', runner.manager);
    await runner.manager.update(RuntimeAssetEntity, assetId, { metadata: {
      activeRevision: 'v2', activeGatewaySnapshotFingerprint: fingerprint,
    } });
    release(); await pending; initialize.mockRestore();
    const published = service.readActiveRouteCatalog();
    const stillPending = runner.isTransactionActive;
    while (runner.isTransactionActive) await runner.rollbackTransaction();
    service.rollbackRuntimeAsset(assetId);
    expect(stillPending).toBe(true);
    expect(published.routes[0].revision).toBe(previous.routes[0].revision);
  });

  it('rollback candidate emits zero notifications and leaves no persisted candidate', async () => {
    await stage('rollback');
    await expect(db.transaction(async manager => {
      await service.activateCandidate('rollback', manager);
      throw new Error('rollback');
    })).rejects.toThrow('rollback');
    service.rollbackRuntimeAsset(assetId);
    expect(events).toHaveLength(0);
    expect(await db.getRepository(GatewayRouteSnapshotEntity).count()).toBe(0);
    expect(() => service.readActiveRouteCatalog()).toThrow('NOT_READY');
  });

  it.each(['gateway_stopped', 'gateway_deleted'])('fences delayed reload and queued reload after %s', async reason => {
    await commit('v1'); await service.reload();
    const original = (service as any).readCommittedSnapshotRows.bind(service);
    let release!: () => void;
    let captured!: () => void;
    const ready = new Promise<void>(resolve => { captured = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    jest.spyOn(service as any, 'readCommittedSnapshotRows').mockImplementationOnce(async () => {
      const rows = await original(); captured(); await held; return rows;
    });
    const reload = service.reload(); await ready;
    const queued = service.reload();
    service.handleSnapshotRefreshRequested({ reason: `runtime_assets.${reason}`, runtimeAssetId: assetId });
    expect(service.readActiveRouteCatalog().routes).toEqual([]);
    release(); await Promise.all([reload, queued]);
    expect(service.readActiveRouteCatalog().routes).toEqual([]);
    expect(service.resolve('localhost', 'GET', '/fixture')).toBeNull();
    expect(events.slice(1).every(event => event.snapshot.routes.length === 0)).toBe(true);
    // A raw reload cannot lift a host stop even if the DB status remains stale.
    await service.reload(); expect(service.readActiveRouteCatalog().routes).toEqual([]);
  });

  it('a later trusted deploy can reload the committed asset', async () => {
    await commit('v1'); await service.reload();
    service.handleSnapshotRefreshRequested({ reason: 'runtime_assets.gateway_stopped', runtimeAssetId: assetId });
    service.handleSnapshotRefreshRequested({ reason: 'runtime_assets.gateway_deployed', runtimeAssetId: assetId });
    await service.reload();
    expect(service.readActiveRouteCatalog().routes[0].revision).toBe('v1');
  });

  it('corrupt reload leaves last verified catalog and routing reference unchanged', async () => {
    await commit('v1'); await service.reload();
    const previous = service.readActiveRouteCatalog(); const routing = (service as any).snapshot;
    await db.getRepository(GatewayRouteSnapshotEntity).update({ runtimeAssetId: assetId }, { fingerprint: '0'.repeat(64) });
    await expect(service.reload()).rejects.toThrow('INVALID');
    expect(service.readActiveRouteCatalog()).toBe(previous);
    expect((service as any).snapshot).toBe(routing); expect(events).toHaveLength(1);
  });

  it('failed synchronous database capture leaves the old catalog and routing untouched', async () => {
    await commit('v1'); await service.reload();
    const previous = service.readActiveRouteCatalog(); const routing = (service as any).snapshot;
    const failure = jest.spyOn(db.driver as any, 'export').mockImplementationOnce(() => { throw new Error('capture failed'); });
    await expect(service.reload()).rejects.toThrow('capture failed'); failure.mockRestore();
    expect(service.readActiveRouteCatalog()).toBe(previous);
    expect((service as any).snapshot).toBe(routing); expect(events).toHaveLength(1);
    expect(db.createQueryRunner().isTransactionActive).toBe(false);
  });

  it('restores only committed catalog after SQL.js export/reopen', async () => {
    await commit('v1'); await service.reload();
    const database = (db.driver as any).export();
    service.onModuleDestroy(); await db.destroy();
    db = await new DataSource({ type: 'sqljs', entities, database, synchronize: false }).initialize();
    service = createService();
    expect(() => service.readActiveRouteCatalog()).toThrow('NOT_READY');
    await service.onModuleInit(); expect(service.readActiveRouteCatalog().routes[0].revision).toBe('v1');
  });

  it.each(['throw', 'async'])('observer %s fails closed and aborts all subscriptions', async kind => {
    const subscription = service.observeActiveRouteCatalog(kind === 'throw'
      ? () => { throw new Error('private detail'); }
      : (() => Promise.resolve()) as any);
    await commit('v1'); await service.reload();
    expect(subscription.signal.aborted).toBe(true);
    expect(() => service.readActiveRouteCatalog()).toThrow('NOT_READY');
    expect(() => service.observeActiveRouteCatalog(() => undefined)).toThrow('NOT_READY');
  });

  it('reentrant stop never delivers the superseded reload after a removal', async () => {
    service.observeActiveRouteCatalog(event => {
      if (event.kind === 'reload') service.handleSnapshotRefreshRequested({
        reason: 'runtime_assets.gateway_stopped', runtimeAssetId: assetId,
      });
    });
    const observed: GatewayActiveRouteCatalogEvent[] = [];
    service.observeActiveRouteCatalog(event => { observed.push(event); });
    await commit('v1'); await service.reload();
    expect(observed.map(event => event.kind)).toEqual(['removed']);
    expect(service.readActiveRouteCatalog().routes).toEqual([]);
    expect(service.resolve('localhost', 'GET', '/fixture')).toBeNull();
  });

  it('unsubscribe removes callbacks and destroy aborts subscribers before a delayed reload can publish', async () => {
    await commit('v1');
    const callback = jest.fn(); const closed = service.observeActiveRouteCatalog(callback); closed.close();
    const live = service.observeActiveRouteCatalog(() => undefined);
    const original = (service as any).readCommittedSnapshotRows.bind(service);
    let release!: () => void; let captured!: () => void;
    const ready = new Promise<void>(resolve => { captured = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    jest.spyOn(service as any, 'readCommittedSnapshotRows').mockImplementationOnce(async () => {
      const rows = await original(); captured(); await held; return rows;
    });
    const pending = service.reload(); await ready; service.onModuleDestroy(); release(); await pending;
    expect(live.signal.aborted).toBe(true); expect(callback).not.toHaveBeenCalled();
    expect(events).toHaveLength(0); expect(() => service.readActiveRouteCatalog()).toThrow('NOT_READY');
  });
});
