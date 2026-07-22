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
    const runtimeAssetRepository = {
      findByIds: jest.fn().mockResolvedValue([
        {
          id: 'runtime-1',
          type: RuntimeAssetType.GATEWAY_SERVICE,
          status: RuntimeAssetStatus.ACTIVE,
          servicePrefix,
        },
      ]),
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
    const gatewayPolicyService = {
      compileForRoute: jest.fn().mockImplementation(routeBinding => ({
        auth: {
          ref: routeBinding.authPolicyRef,
          mode: routeBinding.authPolicyRef ? 'jwt' : 'anonymous',
        },
        traffic: {
          ref: routeBinding.trafficPolicyRef,
          timeoutMs: routeBinding.timeoutMs ?? 30000,
        },
        logging: {
          ref: routeBinding.loggingPolicyRef,
          captureMode: 'meta_only',
        },
        cache: {
          ref: routeBinding.cachePolicyRef,
          enabled: Boolean(routeBinding.cachePolicyRef),
          methods: ['GET', 'HEAD'],
        },
        upstream: {
          raw: routeBinding.upstreamConfig,
        },
      })),
    };
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
      gatewayPolicyService as any,
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

    await service.reload();

    expect(service.resolve('localhost:9001', 'GET', '/pets/special')).toBeNull();
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
});
