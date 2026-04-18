import { of } from 'rxjs';
import { GatewayRuntimeService } from './gateway-runtime.service';

describe('GatewayRuntimeService', () => {
  it('forwards request with matched path params to upstream path', async () => {
    const httpService = {
      request: jest.fn().mockReturnValue(
        of({
          status: 200,
          headers: { 'content-type': 'application/json' },
          data: { ok: true },
        }),
      ),
    };
    const publicationService = {
      resolveActiveGatewayTarget: jest.fn().mockResolvedValue({
        runtimeAsset: {
          id: 'gateway-asset-1',
        },
        membership: {
          id: 'membership-1',
        },
        binding: {
          endpointId: 'endpoint-1',
          routePath: '/pets/{id}',
          routeMethod: 'GET',
          upstreamPath: '/pets/{id}',
          upstreamMethod: 'GET',
          timeoutMs: 5000,
        },
        params: {
          id: '123',
        },
        publishBinding: {
          publishedToHttp: true,
        },
        upstreamBaseUrl: 'https://api.example.com',
      }),
    };
    const gatewayRuntimeMetricsService = {
      recordForwardResult: jest.fn(),
    };

    const service = new GatewayRuntimeService(
      httpService as any,
      publicationService as any,
      gatewayRuntimeMetricsService as any,
    );

    const result = await service.forwardRequest('/pets/123', {
      method: 'GET',
      originalUrl: '/v1/gateway/pets/123?include=owner',
      body: undefined,
      headers: {
        authorization: 'Bearer token',
        host: 'localhost:9001',
      },
    } as any);

    expect(publicationService.resolveActiveGatewayTarget).toHaveBeenCalledWith(
      '/pets/123',
      'GET',
    );
    expect(httpService.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'GET',
        url: 'https://api.example.com/pets/123?include=owner',
        timeout: 5000,
        headers: {
          authorization: 'Bearer token',
        },
      }),
    );
    expect(gatewayRuntimeMetricsService.recordForwardResult).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeAssetId: 'gateway-asset-1',
        runtimeMembershipId: 'membership-1',
        routePath: '/pets/{id}',
        routeMethod: 'GET',
        statusCode: 200,
        success: true,
      }),
    );
    expect(result).toEqual({
      status: 200,
      headers: { 'content-type': 'application/json' },
      data: { ok: true },
    });
  });

  it('returns not found when the route is not published to gateway runtime', async () => {
    const service = new GatewayRuntimeService(
      { request: jest.fn() } as any,
      {
        resolveActiveGatewayTarget: jest.fn().mockResolvedValue(null),
      } as any,
      {
        recordForwardResult: jest.fn(),
      } as any,
    );

    await expect(
      service.forwardRequest('/pets/123', {
        method: 'GET',
        originalUrl: '/v1/gateway/pets/123',
        headers: {},
      } as any),
    ).rejects.toThrow('No active gateway route for GET /pets/123');
  });
});
