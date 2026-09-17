import 'reflect-metadata';
import { createHash } from 'node:crypto';
import { DataSource } from 'typeorm';
import { GatewayRouteSnapshotEntity } from '../../../database/entities/gateway-route-snapshot.entity';
import { RuntimeAssetEntity } from '../../../database/entities/runtime-asset.entity';
import {
  GatewayRoutePathMatchMode,
  GatewayRouteBindingStatus,
} from '../../../database/entities/gateway-route-binding.entity';
import {
  PublicationBindingStatus,
} from '../../../database/entities/endpoint-publish-binding.entity';
import {
  RuntimeAssetEndpointBindingStatus,
} from '../../../database/entities/runtime-asset-endpoint-binding.entity';
import {
  RuntimeAssetStatus,
  RuntimeAssetType,
} from '../../../database/entities/runtime-asset.entity';
import { GatewayPolicyService } from './gateway-policy.service';
import { GatewayRouteSnapshotService } from './gateway-route-snapshot.service';

describe('GatewayRouteSnapshotService', () => {
  const buildService = (servicePrefix?: string) => {
    const persistedSnapshots: any[] = [];
    const persistedSnapshotRepository = {
      find: jest.fn(async () => [...persistedSnapshots].reverse()),
      create: jest.fn(value => value),
      save: jest.fn(async value => {
        persistedSnapshots.push({ id: `snapshot-${persistedSnapshots.length + 1}`, ...value });
        return value;
      }),
    };
    const routeBindingRepository = {
      find: jest.fn().mockResolvedValue([
        {
          id: 'route-param',
          runtimeAssetEndpointBindingId: 'membership-1',
          routePath: '/pets/{id}',
          routeMethod: 'GET',
          authPolicyRef: 'jwt-default',
          upstreamPath: '/upstream/pets/{id}',
          upstreamMethod: 'GET',
          status: GatewayRouteBindingStatus.ACTIVE,
          updatedAt: new Date('2026-04-20T12:00:00Z'),
        },
        {
          id: 'route-static',
          runtimeAssetEndpointBindingId: 'membership-2',
          routePath: '/pets/special',
          routeMethod: 'GET',
          authPolicyRef: 'jwt-default',
          upstreamPath: '/upstream/pets/special',
          upstreamMethod: 'GET',
          status: GatewayRouteBindingStatus.ACTIVE,
          updatedAt: new Date('2026-04-20T12:00:01Z'),
        },
      ]),
    };
    const runtimeBindingRepository = {
      findByIds: jest.fn().mockResolvedValue([
        {
          id: 'membership-1',
          runtimeAssetId: 'runtime-1',
          endpointDefinitionId: 'endpoint-1',
          status: RuntimeAssetEndpointBindingStatus.ACTIVE,
          enabled: true,
        },
        {
          id: 'membership-2',
          runtimeAssetId: 'runtime-1',
          endpointDefinitionId: 'endpoint-2',
          status: RuntimeAssetEndpointBindingStatus.ACTIVE,
          enabled: true,
        },
      ]),
    };
    const publishBindingRepository = {
      find: jest.fn().mockResolvedValue([
        {
          runtimeAssetEndpointBindingId: 'membership-1',
          publishStatus: PublicationBindingStatus.ACTIVE,
          publishedToHttp: true,
        },
        {
          runtimeAssetEndpointBindingId: 'membership-2',
          publishStatus: PublicationBindingStatus.ACTIVE,
          publishedToHttp: true,
        },
      ]),
    };
    const runtimeAssets = [{
      id: 'runtime-1',
      type: RuntimeAssetType.GATEWAY_SERVICE,
      status: RuntimeAssetStatus.ACTIVE,
      servicePrefix,
    }];
    const runtimeAssetRepository = {
      find: jest.fn(async () => runtimeAssets),
      findByIds: jest.fn(async () => runtimeAssets),
    };
    const endpointDefinitionRepository = {
      findByIds: jest.fn().mockResolvedValue([
        {
          id: 'endpoint-1',
          sourceServiceAssetId: 'source-1',
        },
        {
          id: 'endpoint-2',
          sourceServiceAssetId: 'source-1',
        },
      ]),
    };
    const sourceServiceRepository = {
      findByIds: jest.fn().mockResolvedValue([
        {
          id: 'source-1',
          scheme: 'https',
          host: 'api.example.com',
          port: 443,
          normalizedBasePath: '/base',
        },
      ]),
    };
    const gatewayPolicyService = new GatewayPolicyService();
    const runtimeUpstreamBindingsService = {
      resolve: jest.fn().mockResolvedValue({
        resolved: true,
        reason: 'resolved',
        instance: {
          id: 'instance-1',
          sourceServiceAssetId: 'source-1',
          scheme: 'https',
          host: 'api.example.com',
          port: 443,
          basePath: '/base',
        },
      }),
    };

    return new GatewayRouteSnapshotService(
      gatewayPolicyService,
      routeBindingRepository as any,
      persistedSnapshotRepository as any,
      runtimeBindingRepository as any,
      publishBindingRepository as any,
      runtimeAssetRepository as any,
      endpointDefinitionRepository as any,
      sourceServiceRepository as any,
      runtimeUpstreamBindingsService as any,
    );
  };

  const activateFixture = async (service: GatewayRouteSnapshotService, revision = 'fixture') => {
    await service.prepareCandidate('runtime-1', revision);
    await service.activateCandidate(revision);
  };

  it('prefers static routes over parameter routes after candidate activation', async () => {
    const service = buildService();
    await activateFixture(service);

    const result = service.resolve('localhost:9001', 'GET', '/pets/special');

    expect(result?.routeBinding.id).toBe('route-static');
  });

  it('scopes published routes under the runtime asset service prefix', async () => {
    const service = buildService('orders');
    await activateFixture(service);

    expect(service.resolve('localhost:9001', 'GET', '/orders/pets/special')?.routeBinding.id).toBe(
      'route-static',
    );
    expect(service.resolve('localhost:9001', 'GET', '/pets/special')).toBeNull();
  });

  it('resolves parameterized routes and extracts params', async () => {
    const service = buildService();
    await activateFixture(service);

    const result = service.resolve('localhost:9001', 'GET', '/pets/123');

    expect(result?.routeBinding.id).toBe('route-param');
    expect(result?.params).toEqual({ id: '123' });
    expect(result?.upstreamBaseUrl).toBe('https://api.example.com/base');
    expect(result?.policies.traffic.timeoutMs).toBe(30000);
  });

  it('respects matchHost when the binding is host-specific', async () => {
    const service = buildService();
    await activateFixture(service);

    const routeBindings = (service as any).snapshot as any[];
    const parameterRoute = routeBindings.find(
      entry => entry.routeBinding.id === 'route-param',
    );
    parameterRoute.routeBinding.matchHost = 'gateway.internal';

    expect(service.resolve('gateway.internal:9001', 'GET', '/pets/123')?.routeBinding.id).toBe(
      'route-param',
    );
    expect(service.resolve('public.example.com:9001', 'GET', '/pets/123')).toBeNull();
  });

  it('does not reload public routes for an unverified publication change', async () => {
    const service = buildService();
    const reloadSpy = jest.spyOn(service, 'reload').mockResolvedValue(undefined);

    service.handleSnapshotRefreshRequested({
      reason: 'publication.membership_published',
      runtimeAssetId: 'runtime-1',
    });

    await Promise.resolve();
    expect(reloadSpy).not.toHaveBeenCalled();
  });

  it('reloads persisted routes only after verified deployment', async () => {
    const service = buildService();
    const reloadSpy = jest.spyOn(service, 'reload').mockResolvedValue(undefined);

    service.handleSnapshotRefreshRequested({
      reason: 'runtime_assets.gateway_deployed',
      runtimeAssetId: 'runtime-1',
    });

    await Promise.resolve();
    expect(reloadSpy).toHaveBeenCalledTimes(1);
  });

  it('restores a persisted snapshot when its verification fingerprint matches', async () => {
    const service = buildService();
    const prepared = await service.prepareCandidate('runtime-1', 'revision-current');
    await service.activateCandidate('revision-current');
    const active = service.resolve('localhost:9001', 'GET', '/pets/special');
    active!.runtimeAsset.metadata = {
      activeRevision: 'revision-current',
      activeGatewaySnapshotFingerprint: prepared.snapshotFingerprint,
    };
    (service as any).snapshot = [];

    await service.reload();

    expect(service.resolve('localhost:9001', 'GET', '/pets/special')?.routeBinding.id).toBe(
      'route-static',
    );
  });

  it('refuses to restore a persisted snapshot when its verification fingerprint is stale', async () => {
    const service = buildService();
    const prepared = await service.prepareCandidate('runtime-1', 'revision-stale');
    await service.activateCandidate('revision-stale');
    const active = service.resolve('localhost:9001', 'GET', '/pets/special');
    active!.runtimeAsset.metadata = {
      activeRevision: 'revision-stale',
      activeGatewaySnapshotFingerprint: prepared.snapshotFingerprint,
    };
    const persisted = await (service as any).persistedSnapshotRepository.find();
    persisted[0].fingerprint = `${prepared.snapshotFingerprint}-stale`;

    await expect(service.reload()).rejects.toThrow('GATEWAY_ACTIVE_SNAPSHOT_INVALID');
    expect(service.resolve('localhost:9001', 'GET', '/pets/special')?.routeBinding.id)
      .toBe('route-static');

    const restarted = new GatewayRouteSnapshotService(
      new GatewayPolicyService(),
      (service as any).routeBindingRepository,
      (service as any).persistedSnapshotRepository,
      (service as any).runtimeBindingRepository,
      (service as any).publishBindingRepository,
      (service as any).runtimeAssetRepository,
      (service as any).endpointDefinitionRepository,
      (service as any).sourceServiceRepository,
      (service as any).runtimeUpstreamBindingsService,
    );
    await expect(restarted.onModuleInit()).rejects.toThrow('GATEWAY_ACTIVE_SNAPSHOT_INVALID');
    expect(restarted.resolve('localhost:9001', 'GET', '/pets/special')).toBeNull();
  });


  it('rejects a missing published snapshot on cold start and keeps hot routes', async () => {
    const service = buildService();
    const prepared = await service.prepareCandidate('runtime-1', 'published-missing');
    await service.activateCandidate('published-missing');
    const active = service.resolve('localhost:9001', 'GET', '/pets/special')!;
    active.runtimeAsset.metadata = {
      activeRevision: 'published-missing',
      activeGatewaySnapshotFingerprint: prepared.snapshotFingerprint,
    };
    (service as any).persistedSnapshotRepository.find.mockResolvedValue([]);
    await expect(service.reload()).rejects.toThrow('GATEWAY_ACTIVE_SNAPSHOT_MISSING');
    expect(service.resolve('localhost:9001', 'GET', '/pets/special')?.routeBinding.id)
      .toBe('route-static');

    const restarted = new GatewayRouteSnapshotService(
      new GatewayPolicyService(),
      (service as any).routeBindingRepository,
      (service as any).persistedSnapshotRepository,
      (service as any).runtimeBindingRepository,
      (service as any).publishBindingRepository,
      (service as any).runtimeAssetRepository,
      (service as any).endpointDefinitionRepository,
      (service as any).sourceServiceRepository,
      (service as any).runtimeUpstreamBindingsService,
    );
    await expect(restarted.onModuleInit()).rejects.toThrow('GATEWAY_ACTIVE_SNAPSHOT_MISSING');
    expect(restarted.resolve('localhost:9001', 'GET', '/pets/special')).toBeNull();
  });

  it.each(['empty', 'count-mismatch'])(
    'rejects a persisted active snapshot with %s routes without replacing hot routes',
    async corruption => {
      const service = buildService();
      const prepared = await service.prepareCandidate('runtime-1', 'invalid-count');
      await service.activateCandidate('invalid-count');
      const active = service.resolve('localhost:9001', 'GET', '/pets/special')!;
      active.runtimeAsset.metadata = {
        activeRevision: 'invalid-count',
        activeGatewaySnapshotFingerprint: prepared.snapshotFingerprint,
      };
      const persisted = await (service as any).persistedSnapshotRepository.find();
      if (corruption === 'empty') {
        persisted[0].payload = [];
        persisted[0].routeCount = 0;
        const fingerprint = createHash('sha256').update('[]').digest('hex');
        persisted[0].fingerprint = fingerprint;
        active.runtimeAsset.metadata.activeGatewaySnapshotFingerprint = fingerprint;
      } else {
        persisted[0].routeCount = 0;
      }
      await expect(service.reload()).rejects.toThrow('GATEWAY_ACTIVE_SNAPSHOT_INVALID');
      expect(service.resolve('localhost:9001', 'GET', '/pets/special')?.routeBinding.id)
        .toBe('route-static');
    },
  );

  it.each([undefined, 'unknown-policy', 'oauth'])(
    'rejects candidate publication with missing or unsupported auth policy %s',
    async policy => {
      const service = buildService();
      const routes = (service as any).routeBindingRepository;
      const configured = await routes.find();
      routes.find.mockResolvedValue(configured.map((route: any) =>
        route.id === 'route-static' ? { ...route, authPolicyRef: policy } : route));
      await expect(service.prepareCandidate('runtime-1', 'invalid-policy'))
        .rejects.toThrow();
      expect(service.getCandidateRoute('invalid-policy', 'membership-2')).toBeNull();
      expect(service.resolve('localhost:9001', 'GET', '/pets/special')).toBeNull();
      expect(await (service as any).persistedSnapshotRepository.find()).toEqual([]);
    },
  );

  it('refuses activation if a prepared candidate policy is later changed', async () => {
    const service = buildService();
    await service.prepareCandidate('runtime-1', 'candidate-tampered');
    const route = service.getCandidateRoute('candidate-tampered', 'membership-2')!;
    (route.policies.auth as any).mode = 'anonymous';
    await expect(service.activateCandidate('candidate-tampered'))
      .rejects.toThrow('GATEWAY_SNAPSHOT_POLICY_INVALID');
    expect(service.resolve('localhost:9001', 'GET', '/pets/special')).toBeNull();
    expect(await (service as any).persistedSnapshotRepository.find()).toEqual([]);
  });

  it('rejects publication when a prepared route no longer matches its fingerprint', async () => {
    const service = buildService();
    await service.prepareCandidate('runtime-1', 'candidate-stale-fingerprint');
    const route = service.getCandidateRoute('candidate-stale-fingerprint', 'membership-2')!;
    route.normalizedRoutePath = '/changed-after-preparation';
    await expect(service.activateCandidate('candidate-stale-fingerprint'))
      .rejects.toThrow('GATEWAY_CANDIDATE_FINGERPRINT_INVALID');
    expect(await (service as any).persistedSnapshotRepository.find()).toEqual([]);
    expect(service.resolve('localhost:9001', 'GET', '/changed-after-preparation')).toBeNull();
  });

  it('preserves the prior registry when a hot deployment reload finds a bad fingerprint', async () => {
    const service = buildService();
    const prepared = await service.prepareCandidate('runtime-1', 'hot-recovery');
    await service.activateCandidate('hot-recovery');
    const active = service.resolve('localhost:9001', 'GET', '/pets/special')!;
    active.runtimeAsset.metadata = {
      activeRevision: 'hot-recovery',
      activeGatewaySnapshotFingerprint: prepared.snapshotFingerprint,
    };
    const persisted = await (service as any).persistedSnapshotRepository.find();
    persisted[0].fingerprint = '0'.repeat(64);
    const log = jest.spyOn((service as any).logger, 'error').mockImplementation(() => {});
    try {
      service.handleSnapshotRefreshRequested({
        reason: 'runtime_assets.gateway_deployed', runtimeAssetId: 'runtime-1',
      });
      await new Promise(resolve => setImmediate(resolve));
      expect(log).toHaveBeenCalledWith('Rejected invalid Gateway snapshot during hot reload');
      expect(service.resolve('localhost:9001', 'GET', '/pets/special')?.policies.auth.mode)
        .toBe('jwt');
    } finally { log.mockRestore(); }
  });

  it.each(['missing', 'unknown', 'downgraded', 'unknown-ref'])(
    'rejects a self-consistent but invalid active policy snapshot %s',
    async corruption => {
      const service = buildService();
      const prepared = await service.prepareCandidate('runtime-1', 'revision-policy');
      await service.activateCandidate('revision-policy');
      const active = service.resolve('localhost:9001', 'GET', '/pets/special')!;
      active.runtimeAsset.metadata = {
        activeRevision: 'revision-policy',
        activeGatewaySnapshotFingerprint: prepared.snapshotFingerprint,
      };
      const persisted = await (service as any).persistedSnapshotRepository.find();
      const entry = persisted[0].payload[0];
      if (corruption === 'missing') delete entry.policies.auth.mode;
      if (corruption === 'unknown') entry.policies.auth.mode = 'unsupported';
      if (corruption === 'downgraded') entry.policies.auth.mode = 'anonymous';
      if (corruption === 'unknown-ref') entry.routeBinding.authPolicyRef = 'removed-policy';
      const entries = (service as any).deserializeEntries(
        persisted[0].payload, active.runtimeAsset,
      );
      const fingerprint = (service as any).fingerprintEntries(entries);
      persisted[0].fingerprint = fingerprint;
      active.runtimeAsset.metadata.activeGatewaySnapshotFingerprint = fingerprint;
      await expect(service.reload()).rejects.toThrow('GATEWAY_ACTIVE_SNAPSHOT_INVALID');
      expect(service.resolve('localhost:9001', 'GET', '/pets/special')?.policies.auth.mode)
        .toBe('jwt');
    },
  );

  it('keeps an explicit internal development anonymous ref traceable as JWT', async () => {
    const service = buildService();
    const routes = (service as any).routeBindingRepository;
    const configured = await routes.find();
    routes.find.mockResolvedValue(configured.map((route: any) => ({
      ...route, authPolicyRef: 'anonymous', routeVisibility: 'internal',
    })));
    const prepared = await service.prepareCandidate('runtime-1', 'development-mode');
    await service.activateCandidate('development-mode');
    const active = service.resolve('localhost:9001', 'GET', '/pets/special')!;
    expect(active.policies.auth).toEqual(expect.objectContaining({
      ref: 'anonymous', mode: 'jwt',
    }));
    active.runtimeAsset.metadata = {
      activeRevision: 'development-mode',
      activeGatewaySnapshotFingerprint: prepared.snapshotFingerprint,
    };
    await service.reload();
    expect(service.resolve('localhost:9001', 'GET', '/pets/special')?.policies.auth)
      .toEqual(expect.objectContaining({ ref: 'anonymous', mode: 'jwt' }));
  });

  it('removes only the stopped runtime without reloading unverified database state', async () => {
    const service = buildService();
    await activateFixture(service);
    const reloadSpy = jest.spyOn(service, 'reload');

    service.handleSnapshotRefreshRequested({
      reason: 'runtime_assets.gateway_stopped',
      runtimeAssetId: 'runtime-1',
    });

    expect(service.resolve('localhost:9001', 'GET', '/pets/special')).toBeNull();
    expect(reloadSpy).not.toHaveBeenCalled();
  });

  it('matches prefix routes when pathMatchMode is prefix', async () => {
    const service = buildService();
    await activateFixture(service);

    const routeBindings = (service as any).snapshot as any[];
    const parameterRoute = routeBindings.find(
      entry => entry.routeBinding.id === 'route-param',
    );
    parameterRoute.routeBinding.pathMatchMode = GatewayRoutePathMatchMode.PREFIX;
    parameterRoute.normalizedRoutePath = '/pets';

    expect(service.resolve('localhost:9001', 'GET', '/pets/123/owner')?.routeBinding.id).toBe(
      'route-param',
    );
  });

  it('stages an inactive runtime without changing active routes and supports atomic rollback', async () => {
    const service = buildService('orders');
    const runtimeAssetRepository = (service as any).runtimeAssetRepository;
    runtimeAssetRepository.findByIds.mockResolvedValue([
      {
        id: 'runtime-1',
        type: RuntimeAssetType.GATEWAY_SERVICE,
        status: RuntimeAssetStatus.DRAFT,
        servicePrefix: 'orders',
      },
    ]);

    await service.reload();
    expect(service.resolve('localhost:9001', 'GET', '/orders/pets/special')).toBeNull();

    const candidate = await service.prepareCandidate('runtime-1', 'candidate-revision-1');
    expect(candidate.routeCount).toBe(2);
    expect(
      service.resolveCandidate(
        'candidate-revision-1',
        'localhost:9001',
        'GET',
        '/orders/pets/special',
      )?.routeBinding.id,
    ).toBe('route-static');
    expect(service.resolve('localhost:9001', 'GET', '/orders/pets/special')).toBeNull();

    const activation = await service.activateCandidate('candidate-revision-1');
    expect(activation).toEqual(
      expect.objectContaining({ activeRouteCount: 2, previousRouteCount: 0 }),
    );
    expect(service.resolve('localhost:9001', 'GET', '/orders/pets/special')?.routeBinding.id).toBe(
      'route-static',
    );

    expect(service.rollbackRuntimeAsset('runtime-1')).toEqual(
      expect.objectContaining({ rolledBack: true, activeRouteCount: 0 }),
    );
    expect(service.resolve('localhost:9001', 'GET', '/orders/pets/special')).toBeNull();
  });

  it('rejects a bad active fingerprint after real SQL.js export and cold restart', async () => {
    const entities = [GatewayRouteSnapshotEntity, RuntimeAssetEntity];
    let db = await new DataSource({
      type: 'sqljs', entities, synchronize: true,
    }).initialize();
    try {
      const runtimeAssetId = '00000000-0000-0000-0000-000000000001';
      const createRestorer = () => new GatewayRouteSnapshotService(
        new GatewayPolicyService(),
        {} as any, db.getRepository(GatewayRouteSnapshotEntity),
        {} as any, {} as any, db.getRepository(RuntimeAssetEntity),
        {} as any, {} as any, {} as any,
      );
      const runtimeAsset = await db.getRepository(RuntimeAssetEntity).save({
        id: runtimeAssetId, name: 'gateway-policy-fixture',
        type: RuntimeAssetType.GATEWAY_SERVICE, status: RuntimeAssetStatus.ACTIVE,
      });
      const routeBinding = {
        id: 'route-1', authPolicyRef: 'jwt-default',
        pathMatchMode: GatewayRoutePathMatchMode.EXACT,
        upstreamPath: '/fixture', upstreamMethod: 'GET',
        createdAt: new Date(), updatedAt: new Date(),
      };
      const entries = [{
        runtimeAsset,
        membership: { id: 'membership-1', publicationRevision: 1 },
        publishBinding: { id: 'publication-1' },
        routeBinding,
        sourceServiceInstance: { id: 'source-1' },
        normalizedRoutePath: '/fixture', routeMethod: 'GET',
        upstreamBaseUrl: 'http://127.0.0.1:1',
        policies: new GatewayPolicyService().compileForRoute(routeBinding as any),
      }];
      const fingerprint = (createRestorer() as any).fingerprintEntries(entries);
      await db.getRepository(RuntimeAssetEntity).update(runtimeAssetId, {
        metadata: {
          activeRevision: 'verified-route',
          activeGatewaySnapshotFingerprint: fingerprint,
        },
      });
      const snapshot = await db.getRepository(GatewayRouteSnapshotEntity).save({
        runtimeAssetId, revision: 'verified-route', fingerprint,
        routeCount: 1, payload: JSON.parse(JSON.stringify(entries)),
        activatedAt: new Date(),
      });
      await expect(createRestorer().onModuleInit()).resolves.toBeUndefined();
      const invalid = '0'.repeat(64);
      await db.getRepository(GatewayRouteSnapshotEntity).update(snapshot.id, {
        fingerprint: invalid,
      });
      await db.getRepository(RuntimeAssetEntity).update(runtimeAssetId, {
        metadata: {
          activeRevision: 'verified-route',
          activeGatewaySnapshotFingerprint: invalid,
        },
      });
      const database = (db.driver as any).export() as Uint8Array;
      await db.destroy();
      db = await new DataSource({
        type: 'sqljs', database, entities, synchronize: false,
      }).initialize();
      await expect(createRestorer().onModuleInit())
        .rejects.toThrow('GATEWAY_ACTIVE_SNAPSHOT_INVALID');
    } finally {
      if (db.isInitialized) await db.destroy();
    }
  });

});
