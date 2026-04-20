import { GatewayRuntimeService } from './gateway-runtime.service';

describe('GatewayRuntimeService', () => {
  it('forwards request with matched path params through proxy engine', async () => {
    const gatewayRouteSnapshotService = {
      resolve: jest.fn().mockReturnValue({
        runtimeAsset: {
          id: 'gateway-asset-1',
        },
        membership: {
          id: 'membership-1',
        },
        routeBinding: {
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
    const gatewayProxyEngineService = {
      forward: jest.fn().mockResolvedValue({
        statusCode: 200,
        headers: { 'content-type': 'application/json' },
        targetUrl: 'https://api.example.com/pets/123?include=owner',
      }),
    };
    const gatewayAccessLogService = {
      recordRequest: jest.fn(),
    };
    const gatewayRuntimeMetricsService = {
      recordForwardResult: jest.fn(),
    };

    const service = new GatewayRuntimeService(
      gatewayRouteSnapshotService as any,
      gatewayProxyEngineService as any,
      gatewayAccessLogService as any,
      gatewayRuntimeMetricsService as any,
    );

    const req = {
      method: 'GET',
      originalUrl: '/v1/gateway/pets/123?include=owner',
      headers: {
        authorization: 'Bearer token',
        host: 'localhost:9001',
        'x-request-id': 'req-123',
        'x-correlation-id': 'corr-123',
      },
    } as any;
    const res = {} as any;

    await service.forwardRequest('/pets/123', req, res);

    expect(gatewayRouteSnapshotService.resolve).toHaveBeenCalledWith(
      'localhost:9001',
      'GET',
      '/pets/123',
    );
    expect(gatewayProxyEngineService.forward).toHaveBeenCalledWith(
      expect.objectContaining({
        upstreamBaseUrl: 'https://api.example.com',
        params: {
          id: '123',
        },
      }),
      req,
      res,
    );
    expect(gatewayRuntimeMetricsService.recordForwardResult).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeAssetId: 'gateway-asset-1',
        runtimeMembershipId: 'membership-1',
        routePath: '/pets/{id}',
        routeMethod: 'GET',
        requestId: 'req-123',
        correlationId: 'corr-123',
        statusCode: 200,
        success: true,
      }),
    );
    expect(gatewayAccessLogService.recordRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: expect.any(String),
        upstreamUrl: 'https://api.example.com/pets/123?include=owner',
        correlationId: 'corr-123',
      }),
    );
  });

  it('returns not found when the route is not published to gateway runtime', async () => {
    const service = new GatewayRuntimeService(
      {
        resolve: jest.fn().mockReturnValue(null),
      } as any,
      {
        forward: jest.fn(),
      } as any,
      {
        recordRequest: jest.fn(),
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
      } as any, {} as any),
    ).rejects.toThrow('No active gateway route for GET /pets/123');
  });

  it('records failed proxy attempts into metrics and access logs', async () => {
    const gatewayAccessLogService = {
      recordRequest: jest.fn(),
    };
    const gatewayRuntimeMetricsService = {
      recordForwardResult: jest.fn(),
    };

    const service = new GatewayRuntimeService(
      {
        resolve: jest.fn().mockReturnValue({
          runtimeAsset: { id: 'runtime-1' },
          membership: { id: 'membership-1' },
          routeBinding: {
            routePath: '/pets/{id}',
            routeMethod: 'GET',
          },
        }),
      } as any,
      {
        forward: jest.fn().mockRejectedValue(new Error('upstream timeout')),
      } as any,
      gatewayAccessLogService as any,
      gatewayRuntimeMetricsService as any,
    );

    const req = {
      method: 'GET',
      originalUrl: '/v1/gateway/pets/123',
      headers: {
        host: 'localhost:9001',
        'x-request-id': 'req-error',
        'x-correlation-id': 'corr-error',
      },
    } as any;
    const res = {} as any;

    await expect(service.forwardRequest('/pets/123', req, res)).rejects.toThrow(
      'upstream timeout',
    );

    expect(gatewayRuntimeMetricsService.recordForwardResult).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeAssetId: 'runtime-1',
        runtimeMembershipId: 'membership-1',
        requestId: 'req-error',
        correlationId: 'corr-error',
        success: false,
        errorMessage: 'upstream timeout',
      }),
    );
    expect(gatewayAccessLogService.recordRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'req-error',
        correlationId: 'corr-error',
        errorMessage: 'upstream timeout',
      }),
    );
  });
});
