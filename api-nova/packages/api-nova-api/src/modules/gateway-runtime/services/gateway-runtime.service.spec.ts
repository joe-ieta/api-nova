import { HttpException, HttpStatus, UnauthorizedException } from '@nestjs/common';
import { GatewayRuntimeService } from './gateway-runtime.service';

describe('GatewayRuntimeService', () => {
  const createDeps = () => {
    const gatewayRouteSnapshotService = {
      resolve: jest.fn(),
    };
    const gatewaySecurityService = {
      authorize: jest.fn(),
    };
    const gatewayTrafficControlService = {
      admit: jest.fn(),
      beforeAttempt: jest.fn(),
      recordAttemptSuccess: jest.fn(),
      recordAttemptFailure: jest.fn(),
      recordRetryAttempt: jest.fn(),
    };
    const gatewayCacheService = {
      resolve: jest.fn().mockReturnValue(null),
      store: jest.fn(),
      writeHit: jest.fn(),
    };
    const gatewayProxyEngineService = {
      forward: jest.fn(),
    };
    const gatewayAccessLogService = {
      recordRequest: jest.fn(),
      recordUnmatchedRequest: jest.fn(),
    };
    const gatewayRuntimeMetricsService = {
      recordCacheResult: jest.fn(),
      recordPolicyEvent: jest.fn(),
      recordPolicyObservabilityEvent: jest.fn(),
      recordForwardResult: jest.fn(),
      recordRouteMiss: jest.fn(),
    };

    const service = new GatewayRuntimeService(
      gatewayRouteSnapshotService as any,
      gatewaySecurityService as any,
      gatewayTrafficControlService as any,
      gatewayCacheService as any,
      gatewayProxyEngineService as any,
      gatewayAccessLogService as any,
      gatewayRuntimeMetricsService as any,
    );

    return {
      service,
      gatewayRouteSnapshotService,
      gatewaySecurityService,
      gatewayTrafficControlService,
      gatewayCacheService,
      gatewayProxyEngineService,
      gatewayAccessLogService,
      gatewayRuntimeMetricsService,
    };
  };

  const createResolvedRoute = (overrides: Record<string, any> = {}) => ({
    runtimeAsset: { id: 'runtime-1' },
    membership: { id: 'membership-1' },
    endpointDefinition: { id: 'endpoint-1' },
    routeBinding: {
      id: 'route-1',
      routePath: '/orders',
      routeMethod: 'GET',
      upstreamPath: '/orders',
      upstreamMethod: 'GET',
      timeoutMs: 5000,
    },
    upstreamBaseUrl: 'https://api.example.com',
    params: {},
    policies: {
      auth: { mode: 'anonymous' },
      traffic: { retryPolicy: { attempts: 1 } },
      cache: { enabled: false, methods: ['GET', 'HEAD'] },
    },
    ...overrides,
  });

  it('forwards request with matched path params through proxy engine', async () => {
    const deps = createDeps();
    deps.gatewayRouteSnapshotService.resolve.mockReturnValue(
      createResolvedRoute({
        runtimeAsset: { id: 'gateway-asset-1' },
        routeBinding: {
          id: 'route-1',
          routePath: '/pets/{id}',
          routeMethod: 'GET',
          upstreamPath: '/pets/{id}',
          upstreamMethod: 'GET',
          timeoutMs: 5000,
        },
        params: { id: '123' },
      }),
    );
    deps.gatewaySecurityService.authorize.mockResolvedValue({ mode: 'anonymous' });
    deps.gatewayTrafficControlService.admit.mockResolvedValue({ release: jest.fn() });
    deps.gatewayTrafficControlService.beforeAttempt.mockResolvedValue(undefined);
    deps.gatewayTrafficControlService.recordAttemptSuccess.mockResolvedValue(undefined);
    deps.gatewayTrafficControlService.recordAttemptFailure.mockResolvedValue(undefined);
    deps.gatewayTrafficControlService.recordRetryAttempt.mockResolvedValue(undefined);
    deps.gatewayProxyEngineService.forward.mockResolvedValue({
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      targetUrl: 'https://api.example.com/pets/123?include=owner',
    });

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

    await deps.service.forwardRequest('/pets/123', req, res);

    expect(deps.gatewayRouteSnapshotService.resolve).toHaveBeenCalledWith(
      'localhost:9001',
      'GET',
      '/pets/123',
    );
    expect(deps.gatewayProxyEngineService.forward).toHaveBeenCalledWith(
      expect.objectContaining({
        upstreamBaseUrl: 'https://api.example.com',
        params: { id: '123' },
      }),
      req,
      res,
      {
        captureResponseBodyMaxBytes: undefined,
      },
    );
    expect(deps.gatewaySecurityService.authorize).toHaveBeenCalled();
    expect(deps.gatewayTrafficControlService.admit).toHaveBeenCalled();
    expect(deps.gatewayCacheService.resolve).toHaveBeenCalled();
    expect(deps.gatewayCacheService.store).toHaveBeenCalled();
    expect(deps.gatewayRuntimeMetricsService.recordForwardResult).toHaveBeenCalledWith(
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
    expect(deps.gatewayAccessLogService.recordRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'req-123',
        upstreamUrl: 'https://api.example.com/pets/123?include=owner',
        correlationId: 'corr-123',
      }),
    );
  });

  it('returns not found when the route is not published to gateway runtime', async () => {
    const deps = createDeps();
    deps.gatewayRouteSnapshotService.resolve.mockReturnValue(null);

    await expect(
      deps.service.forwardRequest(
        '/pets/123',
        {
          method: 'GET',
          originalUrl: '/v1/gateway/pets/123',
          headers: {
            host: 'localhost:9001',
            'x-request-id': 'req-miss',
          },
        } as any,
        {} as any,
      ),
    ).rejects.toThrow('No active gateway route for GET /pets/123');

    expect(deps.gatewayRuntimeMetricsService.recordRouteMiss).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'GET',
        routePath: '/pets/123',
        requestId: 'req-miss',
      }),
    );
    expect(deps.gatewayAccessLogService.recordUnmatchedRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'req-miss',
        routePath: '/pets/123',
        statusCode: 404,
      }),
    );
  });

  it('records failed proxy attempts into metrics and access logs', async () => {
    const deps = createDeps();
    deps.gatewayRouteSnapshotService.resolve.mockReturnValue(
      createResolvedRoute({
        routeBinding: { id: 'route-1', routePath: '/pets/{id}', routeMethod: 'GET' },
      }),
    );
    deps.gatewaySecurityService.authorize.mockResolvedValue({ mode: 'anonymous' });
    deps.gatewayTrafficControlService.admit.mockResolvedValue({ release: jest.fn() });
    deps.gatewayTrafficControlService.beforeAttempt.mockResolvedValue(undefined);
    deps.gatewayTrafficControlService.recordAttemptSuccess.mockResolvedValue(undefined);
    deps.gatewayTrafficControlService.recordAttemptFailure.mockResolvedValue(undefined);
    deps.gatewayTrafficControlService.recordRetryAttempt.mockResolvedValue(undefined);
    deps.gatewayProxyEngineService.forward.mockRejectedValue(new Error('upstream timeout'));

    const req = {
      method: 'GET',
      originalUrl: '/v1/gateway/pets/123',
      headers: {
        host: 'localhost:9001',
        'x-request-id': 'req-error',
        'x-correlation-id': 'corr-error',
      },
    } as any;

    await expect(deps.service.forwardRequest('/pets/123', req, {} as any)).rejects.toThrow(
      'upstream timeout',
    );

    expect(deps.gatewayRuntimeMetricsService.recordForwardResult).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'req-error',
        correlationId: 'corr-error',
        success: false,
        errorMessage: 'upstream timeout',
      }),
    );
    expect(deps.gatewayAccessLogService.recordRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'req-error',
        correlationId: 'corr-error',
        errorMessage: 'upstream timeout',
      }),
    );
  });

  it('records auth failures before proxying', async () => {
    const deps = createDeps();
    deps.gatewayRouteSnapshotService.resolve.mockReturnValue(
      createResolvedRoute({
        routeBinding: { id: 'route-1', routePath: '/pets/{id}', routeMethod: 'GET' },
        policies: {
          auth: { mode: 'jwt' },
          traffic: { retryPolicy: { attempts: 1 } },
          cache: { enabled: false, methods: ['GET', 'HEAD'] },
        },
      }),
    );
    deps.gatewaySecurityService.authorize.mockRejectedValue(
      new UnauthorizedException('Gateway JWT token is required'),
    );

    await expect(
      deps.service.forwardRequest(
        '/pets/123',
        {
          method: 'GET',
          originalUrl: '/v1/gateway/pets/123',
          headers: {
            host: 'localhost:9001',
            'x-request-id': 'req-auth',
          },
        } as any,
        {} as any,
      ),
    ).rejects.toThrow('Gateway JWT token is required');

    expect(deps.gatewayAccessLogService.recordRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'req-auth',
        errorMessage: 'Gateway JWT token is required',
      }),
    );
    expect(deps.gatewayRuntimeMetricsService.recordPolicyEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        policyName: 'gateway.auth_rejected',
      }),
    );
    expect(deps.gatewayRuntimeMetricsService.recordPolicyObservabilityEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        policyName: 'gateway.auth_rejected',
        requestId: 'req-auth',
      }),
    );
  });

  it('records traffic-control rejections before proxying upstream', async () => {
    const deps = createDeps();
    deps.gatewayRouteSnapshotService.resolve.mockReturnValue(createResolvedRoute());
    deps.gatewaySecurityService.authorize.mockResolvedValue({ mode: 'anonymous' });
    deps.gatewayTrafficControlService.admit.mockRejectedValue(
      new HttpException('Gateway rate limit exceeded', HttpStatus.TOO_MANY_REQUESTS),
    );

    await expect(
      deps.service.forwardRequest(
        '/orders',
        {
          method: 'GET',
          originalUrl: '/v1/gateway/orders',
          headers: {
            host: 'localhost:9001',
            'x-request-id': 'req-throttle',
          },
        } as any,
        {} as any,
      ),
    ).rejects.toEqual(
      expect.objectContaining({
        message: 'Gateway rate limit exceeded',
      }),
    );

    expect(deps.gatewayRuntimeMetricsService.recordForwardResult).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'req-throttle',
        statusCode: 429,
        errorMessage: 'Gateway rate limit exceeded',
      }),
    );
  });

  it('retries safe requests when the first upstream attempt fails', async () => {
    const deps = createDeps();
    deps.gatewayRouteSnapshotService.resolve.mockReturnValue(
      createResolvedRoute({
        policies: {
          auth: { mode: 'anonymous' },
          traffic: { retryPolicy: { attempts: 2 } },
          cache: { enabled: false, methods: ['GET', 'HEAD'] },
        },
      }),
    );
    deps.gatewaySecurityService.authorize.mockResolvedValue({ mode: 'anonymous' });
    deps.gatewayTrafficControlService.admit.mockResolvedValue({ release: jest.fn() });
    deps.gatewayTrafficControlService.beforeAttempt.mockResolvedValue(undefined);
    deps.gatewayTrafficControlService.recordAttemptSuccess.mockResolvedValue(undefined);
    deps.gatewayTrafficControlService.recordAttemptFailure.mockResolvedValue(undefined);
    deps.gatewayTrafficControlService.recordRetryAttempt.mockResolvedValue(undefined);
    deps.gatewayProxyEngineService.forward
      .mockRejectedValueOnce(new Error('temporary upstream error'))
      .mockResolvedValueOnce({
        statusCode: 200,
        headers: { 'content-type': 'application/json' },
        targetUrl: 'https://api.example.com/orders',
      });

    await deps.service.forwardRequest(
      '/orders',
      {
        method: 'GET',
        originalUrl: '/v1/gateway/orders',
        headers: { host: 'localhost:9001' },
      } as any,
      {} as any,
    );

    expect(deps.gatewayProxyEngineService.forward).toHaveBeenCalledTimes(2);
    expect(deps.gatewayTrafficControlService.recordAttemptFailure).toHaveBeenCalledTimes(1);
    expect(deps.gatewayTrafficControlService.beforeAttempt).toHaveBeenCalledTimes(1);
    expect(deps.gatewayTrafficControlService.recordRetryAttempt).toHaveBeenCalledWith(
      expect.anything(),
      2,
      expect.objectContaining({ message: 'temporary upstream error' }),
    );
    expect(deps.gatewayTrafficControlService.recordAttemptSuccess).toHaveBeenCalledTimes(1);
  });

  it('does not retry non-idempotent requests unless explicitly enabled', async () => {
    const deps = createDeps();
    deps.gatewayRouteSnapshotService.resolve.mockReturnValue(
      createResolvedRoute({
        routeBinding: {
          id: 'route-1',
          routePath: '/orders',
          routeMethod: 'POST',
          upstreamPath: '/orders',
          upstreamMethod: 'POST',
        },
        policies: {
          auth: { mode: 'anonymous' },
          traffic: { retryPolicy: { attempts: 3 } },
          cache: { enabled: false, methods: ['GET', 'HEAD'] },
        },
      }),
    );
    deps.gatewaySecurityService.authorize.mockResolvedValue({ mode: 'anonymous' });
    deps.gatewayTrafficControlService.admit.mockResolvedValue({ release: jest.fn() });
    deps.gatewayTrafficControlService.beforeAttempt.mockResolvedValue(undefined);
    deps.gatewayTrafficControlService.recordAttemptSuccess.mockResolvedValue(undefined);
    deps.gatewayTrafficControlService.recordAttemptFailure.mockResolvedValue(undefined);
    deps.gatewayTrafficControlService.recordRetryAttempt.mockResolvedValue(undefined);
    deps.gatewayProxyEngineService.forward.mockRejectedValue(
      new Error('temporary upstream error'),
    );

    await expect(
      deps.service.forwardRequest(
        '/orders',
        {
          method: 'POST',
          originalUrl: '/v1/gateway/orders',
          headers: { host: 'localhost:9001' },
        } as any,
        {} as any,
      ),
    ).rejects.toThrow('temporary upstream error');

    expect(deps.gatewayProxyEngineService.forward).toHaveBeenCalledTimes(1);
    expect(deps.gatewayTrafficControlService.recordRetryAttempt).not.toHaveBeenCalled();
    expect(deps.gatewayTrafficControlService.beforeAttempt).not.toHaveBeenCalled();
  });

  it('retries non-idempotent requests only when explicitly enabled', async () => {
    const deps = createDeps();
    deps.gatewayRouteSnapshotService.resolve.mockReturnValue(
      createResolvedRoute({
        routeBinding: {
          id: 'route-1',
          routePath: '/orders',
          routeMethod: 'POST',
          upstreamPath: '/orders',
          upstreamMethod: 'POST',
        },
        policies: {
          auth: { mode: 'anonymous' },
          traffic: { retryPolicy: { attempts: 3, allowNonIdempotent: true } },
          cache: { enabled: false, methods: ['GET', 'HEAD'] },
        },
      }),
    );
    deps.gatewaySecurityService.authorize.mockResolvedValue({ mode: 'anonymous' });
    deps.gatewayTrafficControlService.admit.mockResolvedValue({ release: jest.fn() });
    deps.gatewayTrafficControlService.beforeAttempt.mockResolvedValue(undefined);
    deps.gatewayTrafficControlService.recordAttemptSuccess.mockResolvedValue(undefined);
    deps.gatewayTrafficControlService.recordAttemptFailure.mockResolvedValue(undefined);
    deps.gatewayTrafficControlService.recordRetryAttempt.mockResolvedValue(undefined);
    deps.gatewayProxyEngineService.forward
      .mockRejectedValueOnce(new Error('temporary upstream error'))
      .mockResolvedValueOnce({
        statusCode: 201,
        headers: { 'content-type': 'application/json' },
        targetUrl: 'https://api.example.com/orders',
      });

    await deps.service.forwardRequest(
      '/orders',
      {
        method: 'POST',
        originalUrl: '/v1/gateway/orders',
        headers: { host: 'localhost:9001' },
      } as any,
      {} as any,
    );

    expect(deps.gatewayProxyEngineService.forward).toHaveBeenCalledTimes(2);
    expect(deps.gatewayTrafficControlService.recordRetryAttempt).toHaveBeenCalledWith(
      expect.anything(),
      2,
      expect.objectContaining({ message: 'temporary upstream error' }),
    );
  });

  it('serves cache hits without calling upstream proxy', async () => {
    const deps = createDeps();
    deps.gatewayRouteSnapshotService.resolve.mockReturnValue(
      createResolvedRoute({
        policies: {
          auth: { mode: 'anonymous' },
          traffic: { retryPolicy: { attempts: 1 } },
          cache: { enabled: true, methods: ['GET', 'HEAD'] },
        },
      }),
    );
    deps.gatewaySecurityService.authorize.mockResolvedValue({ mode: 'anonymous' });
    deps.gatewayTrafficControlService.admit.mockResolvedValue({ release: jest.fn() });
    deps.gatewayCacheService.resolve.mockReturnValue({
      key: 'cache-key',
      hit: true,
      entry: {
        statusCode: 200,
        headers: { 'content-type': 'application/json' },
        responseBytes: 11,
        responseBodyPreview: '{"ok":true}',
        responseBodyHash: 'hash-1',
        body: Buffer.from('{"ok":true}', 'utf8'),
      },
    });

    await deps.service.forwardRequest(
      '/orders',
      {
        method: 'GET',
        originalUrl: '/v1/gateway/orders',
        headers: { host: 'localhost:9001', 'x-request-id': 'req-cache-hit' },
      } as any,
      {
        setHeader: jest.fn(),
        getHeader: jest.fn(),
      } as any,
    );

    expect(deps.gatewayCacheService.writeHit).toHaveBeenCalled();
    expect(deps.gatewayProxyEngineService.forward).not.toHaveBeenCalled();
    expect(deps.gatewayRuntimeMetricsService.recordCacheResult).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'req-cache-hit',
        cacheStatus: 'hit',
      }),
    );
  });
});
