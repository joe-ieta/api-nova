import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { GatewayRouteSnapshotEntity } from '../../../database/entities/gateway-route-snapshot.entity';
import {
  RuntimeAssetEntity,
  RuntimeAssetStatus,
  RuntimeAssetType,
} from '../../../database/entities/runtime-asset.entity';
import { GatewayRoutePathMatchMode } from '../../../database/entities/gateway-route-binding.entity';
import { GatewayPolicyService } from './gateway-policy.service';
import { GatewayRouteSnapshotService } from './gateway-route-snapshot.service';
import { inspectGatewayActiveRouteCapture } from './gateway-active-route-capture';
import type { GatewayActiveRouteCatalogEvent } from './gateway-active-route-catalog';

const assetId = '00000000-0000-0000-0000-000000000001';
const entities = [GatewayRouteSnapshotEntity, RuntimeAssetEntity];

describe('committed Gateway active route capture (SQL.js)', () => {
  let db: DataSource;
  let service: GatewayRouteSnapshotService;
  let events: GatewayActiveRouteCatalogEvent[];

  const createService = () => new GatewayRouteSnapshotService(
    new GatewayPolicyService(),
    {} as any,
    db.getRepository(GatewayRouteSnapshotEntity),
    {} as any,
    {} as any,
    db.getRepository(RuntimeAssetEntity),
    {} as any,
    {} as any,
    {} as any,
  );

  const stage = async (revision: string) => {
    const runtimeAsset = await db.getRepository(RuntimeAssetEntity).findOneByOrFail({
      id: assetId,
    });
    const routeBinding = {
      id: 'route-1',
      authPolicyRef: 'jwt-default',
      pathMatchMode: GatewayRoutePathMatchMode.EXACT,
      upstreamPath: '/fixture',
      upstreamMethod: 'GET',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const entries = [{
      runtimeAsset,
      routeBinding,
      membership: { id: 'member-1', publicationRevision: 1 },
      publishBinding: { id: 'pub-1' },
      sourceServiceInstance: { id: 'source-1' },
      normalizedRoutePath: '/fixture',
      routeMethod: 'GET',
      upstreamBaseUrl: 'http://127.0.0.1:1',
      priorityScore: 1,
      policies: new GatewayPolicyService().compileForRoute(routeBinding as any),
    }];
    const fingerprint = (service as any).fingerprintEntries(entries);
    (service as any).candidateSnapshots.set(revision, {
      runtimeAssetId: assetId,
      entries,
      snapshotFingerprint: fingerprint,
      preparedAt: new Date(),
    });
    return fingerprint;
  };

  const commit = async (revision: string) => {
    const fingerprint = await stage(revision);
    await db.transaction(async manager => {
      await service.activateCandidate(revision, manager);
      await manager.update(RuntimeAssetEntity, assetId, {
        metadata: {
          activeRevision: revision,
          activeGatewaySnapshotFingerprint: fingerprint,
        },
      });
    });
  };

  beforeEach(async () => {
    db = await new DataSource({
      type: 'sqljs',
      entities,
      synchronize: true,
    }).initialize();
    await db.getRepository(RuntimeAssetEntity).save({
      id: assetId,
      name: 'capture-fixture',
      type: RuntimeAssetType.GATEWAY_SERVICE,
      status: RuntimeAssetStatus.ACTIVE,
    });
    service = createService();
    events = [];
    service.observeActiveRouteCatalog(event => {
      events.push(event);
    });
  });

  afterEach(async () => {
    service.onModuleDestroy();
    if (db.isInitialized) await db.destroy();
  });

  it('mints only from the exact current catalog and committed route references', async () => {
    await commit('v1');
    expect(() => service.readActiveRouteCatalog()).toThrow('NOT_READY');

    await service.reload();
    const catalog = service.readActiveRouteCatalog();
    const capture = service.captureActiveRouteCatalog(catalog);
    const captured = inspectGatewayActiveRouteCapture(capture);
    const resolved = service.resolve('localhost', 'GET', '/fixture');

    expect(Object.keys(capture).sort()).toEqual(['catalogVersion', 'kind']);
    expect(captured).toHaveLength(1);
    expect(captured[0].identity).toBe(catalog.routes[0]);
    expect(captured[0].route.routeBinding).toBe(resolved?.routeBinding);
    expect(() => service.captureActiveRouteCatalog({ ...catalog }))
      .toThrow('GATEWAY_ACTIVE_ROUTE_CAPTURE_INVALID');
    expect(() => inspectGatewayActiveRouteCapture({ ...capture }))
      .toThrow('GATEWAY_ACTIVE_ROUTE_CAPTURE_INVALID');

    await service.reload();
    expect(() => inspectGatewayActiveRouteCapture(capture))
      .toThrow('GATEWAY_ACTIVE_ROUTE_CAPTURE_STALE');
  });

  it('does not publish candidate or rollback state and swaps only after committed reload', async () => {
    await commit('v1');
    await service.reload();
    const originalCatalog = service.readActiveRouteCatalog();
    const originalCapture = service.captureActiveRouteCatalog(originalCatalog);

    const rollbackFingerprint = await stage('rollback');
    await expect(db.transaction(async manager => {
      await service.activateCandidate('rollback', manager);
      await manager.update(RuntimeAssetEntity, assetId, {
        metadata: {
          activeRevision: 'rollback',
          activeGatewaySnapshotFingerprint: rollbackFingerprint,
        },
      });
      throw new Error('rollback');
    })).rejects.toThrow('rollback');
    service.rollbackRuntimeAsset(assetId);

    expect(events).toHaveLength(1);
    expect(service.readActiveRouteCatalog()).toBe(originalCatalog);
    expect(inspectGatewayActiveRouteCapture(originalCapture)[0].identity.revision).toBe('v1');

    await commit('v2');
    expect(events).toHaveLength(1);
    expect(inspectGatewayActiveRouteCapture(originalCapture)[0].identity.revision).toBe('v1');

    await service.reload();
    expect(events).toHaveLength(2);
    expect(service.readActiveRouteCatalog().routes[0].revision).toBe('v2');
    expect(() => inspectGatewayActiveRouteCapture(originalCapture))
      .toThrow('GATEWAY_ACTIVE_ROUTE_CAPTURE_STALE');
  });

  it.each(['gateway_stopped', 'gateway_deleted'])(
    'revokes exact captures and fences delayed reload after %s',
    async reason => {
      await commit('v1');
      await service.reload();
      const active = service.captureActiveRouteCatalog(service.readActiveRouteCatalog());
      const originalRead = (service as any).readCommittedSnapshotRows.bind(service);
      let release!: () => void;
      let captured!: () => void;
      const ready = new Promise<void>(resolve => {
        captured = resolve;
      });
      const held = new Promise<void>(resolve => {
        release = resolve;
      });
      jest.spyOn(service as any, 'readCommittedSnapshotRows').mockImplementationOnce(async () => {
        const rows = await originalRead();
        captured();
        await held;
        return rows;
      });

      const pending = service.reload();
      await ready;
      service.handleSnapshotRefreshRequested({
        reason: `runtime_assets.${reason}`,
        runtimeAssetId: assetId,
      });
      const removedCatalog = service.readActiveRouteCatalog();
      const removedCapture = service.captureActiveRouteCatalog(removedCatalog);

      expect(() => inspectGatewayActiveRouteCapture(active))
        .toThrow('GATEWAY_ACTIVE_ROUTE_CAPTURE_STALE');
      expect(inspectGatewayActiveRouteCapture(removedCapture)).toEqual([]);
      expect(() => service.captureActiveRouteCatalog({ ...removedCatalog }))
        .toThrow('GATEWAY_ACTIVE_ROUTE_CAPTURE_INVALID');

      release();
      await pending;
      expect(service.readActiveRouteCatalog()).toBe(removedCatalog);
      expect(inspectGatewayActiveRouteCapture(removedCapture)).toEqual([]);
      await service.reload();
      expect(service.readActiveRouteCatalog().routes).toEqual([]);
    },
  );
});
