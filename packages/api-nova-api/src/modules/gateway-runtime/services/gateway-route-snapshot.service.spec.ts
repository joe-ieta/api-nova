import {
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
  const buildService = () => {
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

    return new GatewayRouteSnapshotService(
      routeBindingRepository as any,
      runtimeBindingRepository as any,
      publishBindingRepository as any,
      runtimeAssetRepository as any,
      endpointDefinitionRepository as any,
      sourceServiceRepository as any,
    );
  };

  it('prefers static routes over parameter routes after reload', async () => {
    const service = buildService();
    await service.reload();

    const result = service.resolve('localhost:9001', 'GET', '/pets/special');

    expect(result?.routeBinding.id).toBe('route-static');
  });

  it('resolves parameterized routes and extracts params', async () => {
    const service = buildService();
    await service.reload();

    const result = service.resolve('localhost:9001', 'GET', '/pets/123');

    expect(result?.routeBinding.id).toBe('route-param');
    expect(result?.params).toEqual({ id: '123' });
    expect(result?.upstreamBaseUrl).toBe('https://api.example.com/base');
  });

  it('respects matchHost when the binding is host-specific', async () => {
    const service = buildService();
    await service.reload();

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

  it('reloads when a snapshot refresh event is requested', async () => {
    const service = buildService();
    const reloadSpy = jest.spyOn(service, 'reload').mockResolvedValue(undefined);

    service.handleSnapshotRefreshRequested({
      reason: 'publication.membership_published',
      runtimeAssetId: 'runtime-1',
    });

    await Promise.resolve();
    expect(reloadSpy).toHaveBeenCalled();
  });
});
