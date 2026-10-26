import { HttpException, HttpStatus, UnauthorizedException } from '@nestjs/common';
import { compileHeaderPolicyV1 } from 'api-nova-parser';
import { GatewayRuntimeService } from './gateway-runtime.service';

// This suite tests orchestration with a mocked proxy and non-stream requests.
// Real ingress/stream audit coverage lives in the HTTP observability integration suites.
jest.mock('./gateway-request-audit', () => ({
  beginGatewayRequestAudit: () => ({
    run: (operation: () => unknown) => operation(),
    authenticated() {}, failed() {}, cacheHit() {},
  }),
}));

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
      requiresPreparation: jest.fn().mockReturnValue(false),
      prepareRequest: jest.fn(),
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
    const res = { setHeader: jest.fn() } as any;

    await deps.service.forwardRequest('/pets/123', req, res);
    expect(req.headers['x-request-id']).not.toBe('req-123');
    expect(res.setHeader).toHaveBeenCalledWith('x-request-id', req.headers['x-request-id']);

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
        attemptIndex: 1,
        upstreamOperationId: expect.any(String),
        deadline: expect.any(Number),
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
        requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        correlationId: 'corr-123',
        statusCode: 200,
        success: true,
      }),
    );
    expect(deps.gatewayAccessLogService.recordRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
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
        { setHeader: jest.fn() } as any,
      ),
    ).rejects.toThrow('No active gateway route for GET /pets/123');

    expect(deps.gatewayRuntimeMetricsService.recordRouteMiss).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'GET',
        routePath: '/pets/123',
        requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      }),
    );
    expect(deps.gatewayAccessLogService.recordUnmatchedRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
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

    await expect(deps.service.forwardRequest('/pets/123', req, { setHeader: jest.fn() } as any)).rejects.toThrow(
      'upstream timeout',
    );

    expect(deps.gatewayRuntimeMetricsService.recordForwardResult).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        correlationId: 'corr-error',
        success: false,
        errorMessage: 'upstream timeout',
      }),
    );
    expect(deps.gatewayAccessLogService.recordRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
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
    const response = {
      headersSent: false,
      setHeader: jest.fn(),
    };

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
        response as any,
      ),
    ).rejects.toThrow('Gateway JWT token is required');

    expect(response.setHeader).toHaveBeenCalledWith(
      'WWW-Authenticate',
      'Bearer',
    );

    expect(deps.gatewayAccessLogService.recordRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
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
        requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
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
        { setHeader: jest.fn() } as any,
      ),
    ).rejects.toEqual(
      expect.objectContaining({
        message: 'Gateway rate limit exceeded',
      }),
    );

    expect(deps.gatewayRuntimeMetricsService.recordForwardResult).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
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
      { setHeader: jest.fn() } as any,
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
        { setHeader: jest.fn() } as any,
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
      { setHeader: jest.fn() } as any,
    );

    expect(deps.gatewayProxyEngineService.forward).toHaveBeenCalledTimes(2);
    expect(deps.gatewayTrafficControlService.recordRetryAttempt).toHaveBeenCalledWith(
      expect.anything(),
      2,
      expect.objectContaining({ message: 'temporary upstream error' }),
    );
  });

  it.each([undefined, 'gateway_header_framing', 'gateway_header_early_response'])(
    'preflights v1 cache access and never retries header rejection: %s', async failure => {
      const deps = createDeps();
      const target = createResolvedRoute({ policies: {
        auth: { mode: 'anonymous' }, traffic: { retryPolicy: { attempts: 3 } },
        cache: { enabled: true, methods: ['GET'], maxBodyBytes: 4096 },
        upstream: { compiledHeaderPolicy: compileHeaderPolicyV1({ sourceId: 'cache-test', policy: { version: 1 } }) },
      } });
      deps.gatewayRouteSnapshotService.resolve.mockReturnValue(target);
      deps.gatewaySecurityService.authorize.mockResolvedValue({ mode: 'anonymous' });
      deps.gatewayTrafficControlService.admit.mockResolvedValue({ release: jest.fn() });
      deps.gatewayProxyEngineService.prepareRequest.mockResolvedValue({ requestPolicy: { cacheBypass: false, chunked: false, normalizedRequestHeaders: {} } });
      if (failure) deps.gatewayProxyEngineService.forward.mockRejectedValue(new HttpException(failure, 502));
      else deps.gatewayProxyEngineService.forward.mockResolvedValue({ statusCode: 200, headers: {}, targetUrl: 'https://api.example.com/orders' });
      const action = deps.service.forwardRequest('/orders', {
        method: 'GET', originalUrl: '/api/v1/gateway/orders', headers: { host: 'localhost' },
      } as any, { setHeader: jest.fn() } as any);
      if (failure) await expect(action).rejects.toThrow(failure); else await action;
      expect(deps.gatewaySecurityService.authorize).toHaveBeenCalledTimes(1);
      expect(deps.gatewayProxyEngineService.prepareRequest).toHaveBeenCalledTimes(1);
      expect(deps.gatewayCacheService.resolve).toHaveBeenCalledTimes(1);
      expect(deps.gatewayCacheService.writeHit).not.toHaveBeenCalled();
      expect(deps.gatewayCacheService.store).toHaveBeenCalledTimes(failure ? 0 : 1);
      expect(deps.gatewayProxyEngineService.forward).toHaveBeenCalledTimes(1);
      expect(deps.gatewayProxyEngineService.forward.mock.calls[0][3].captureResponseBodyMaxBytes).toBe(4096);
      expect(deps.gatewayTrafficControlService.recordRetryAttempt).not.toHaveBeenCalled();
    },
  );

  it('uses request-local Registry policy for cache and retry without mutating published route', async () => {
    const deps = createDeps();
    const target = createResolvedRoute({ policies: { auth: { mode: 'anonymous' }, traffic: { retryPolicy: { attempts: 3 } }, cache: { enabled: true, methods: ['GET'] }, upstream: {} } });
    deps.gatewayRouteSnapshotService.resolve.mockReturnValue(target);
    deps.gatewaySecurityService.authorize.mockResolvedValue({ mode: 'anonymous' });
    deps.gatewayTrafficControlService.admit.mockResolvedValue({ release: jest.fn() });
    deps.gatewayProxyEngineService.requiresPreparation.mockReturnValue(true);
    const policy = compileHeaderPolicyV1({ sourceId: 'registry-test', policy: { version: 1 } });
    const prepared = { compiledHeaderPolicy: policy, historicalAuthenticationHeaderNames: ['x-old'], requestPolicy: { cacheBypass: false, normalizedRequestHeaders: {} } };
    deps.gatewayProxyEngineService.prepareRequest.mockResolvedValue(prepared);
    deps.gatewayProxyEngineService.forward.mockRejectedValue(new HttpException('gateway_header_framing', 502));
    await expect(deps.service.forwardRequest('/orders', { method: 'GET', originalUrl: '/api/v1/gateway/orders', headers: { host: 'localhost' } } as any, { setHeader: jest.fn() } as any)).rejects.toThrow('gateway_header_framing');
    expect(deps.gatewayProxyEngineService.prepareRequest).toHaveBeenCalledTimes(1);
    const effective = deps.gatewayCacheService.resolve.mock.calls[0][0];
    expect(effective).not.toBe(target); expect(effective.policies.upstream.compiledHeaderPolicy).toBe(policy);
    expect((target.policies as any).upstream.compiledHeaderPolicy).toBeUndefined();
    expect(deps.gatewayProxyEngineService.forward).toHaveBeenCalledTimes(1);
    expect(deps.gatewayProxyEngineService.forward.mock.calls[0][3].preparedRequest).toBe(prepared);
    expect(deps.gatewayTrafficControlService.recordRetryAttempt).not.toHaveBeenCalled();
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
        requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        cacheStatus: 'hit',
      }),
    );
  });

  const leasedPrepared = () => ({
    networkLease: { strict: true },
    url: new URL('https://api.example.com/orders'),
    credentials: { headers: {}, cacheIdentity: 'identity', managedHeaderNames: [], credentialHeaderNames: [] },
    requestPolicy: { headers: {}, chunked: false, cacheBypass: true },
    compiledHeaderPolicy: { version: 1 },
    historicalAuthenticationHeaderNames: [],
  });
  const networkTarget = () => createResolvedRoute({
    routeBinding: {
      id: 'route-1', routePath: '/orders', routeMethod: 'GET',
      upstreamPath: '/orders', upstreamMethod: 'GET', timeoutMs: 10000,
    },
    policies: {
      auth: { mode: 'anonymous' },
      traffic: { timeoutMs: 10000, retryPolicy: { attempts: 3 } },
      cache: { enabled: true, methods: ['GET', 'HEAD'] },
      upstream: {},
    },
  });

  it('C3 forces one network attempt and reuses the identical prepared lease', async () => {
    const deps = createDeps();
    const target = networkTarget();
    deps.gatewayRouteSnapshotService.resolve.mockReturnValue(target);
    deps.gatewaySecurityService.authorize.mockResolvedValue({ mode: 'anonymous' });
    deps.gatewayTrafficControlService.admit.mockResolvedValue({ release: jest.fn() });
    const prepared = leasedPrepared();
    deps.gatewayProxyEngineService.requiresPreparation.mockReturnValue(true);
    deps.gatewayProxyEngineService.prepareRequest.mockResolvedValue(prepared);
    deps.gatewayProxyEngineService.forward.mockRejectedValue(new Error('upstream failed'));

    await expect(deps.service.forwardRequest('/orders', {
      method: 'GET',
      originalUrl: '/v1/gateway/orders',
      headers: { host: 'localhost:9001' },
    } as any, { setHeader: jest.fn() } as any)).rejects.toThrow('upstream failed');

    expect(deps.gatewayProxyEngineService.prepareRequest).toHaveBeenCalledTimes(1);
    expect(deps.gatewayProxyEngineService.forward).toHaveBeenCalledTimes(1);
    expect(deps.gatewayProxyEngineService.forward.mock.calls[0][3]).toMatchObject({
      attemptIndex: 1,
      preparedRequest: prepared,
    });
    expect(deps.gatewayTrafficControlService.beforeAttempt).not.toHaveBeenCalled();
    expect(deps.gatewayTrafficControlService.recordRetryAttempt).not.toHaveBeenCalled();
  });

  it('C3 anchors one absolute deadline at entry and reuses it for prepare and forward', async () => {
    const deps = createDeps();
    const target = networkTarget();
    deps.gatewayRouteSnapshotService.resolve.mockReturnValue(target);
    deps.gatewaySecurityService.authorize.mockResolvedValue({ mode: 'anonymous' });
    deps.gatewayTrafficControlService.admit.mockResolvedValue({ release: jest.fn() });
    deps.gatewayProxyEngineService.requiresPreparation.mockReturnValue(true);
    deps.gatewayProxyEngineService.prepareRequest.mockResolvedValue(leasedPrepared());
    deps.gatewayProxyEngineService.forward.mockResolvedValue({
      statusCode: 200, headers: {}, targetUrl: 'https://api.example.com/orders',
    });

    const startedAt = Date.now() - 5000;
    await deps.service.forwardResolvedRoute(target as any, {
      method: 'GET',
      originalUrl: '/v1/gateway/orders',
      headers: { host: 'localhost:9001' },
    } as any, { setHeader: jest.fn() } as any, startedAt);

    expect(deps.gatewayProxyEngineService.prepareRequest).toHaveBeenCalledWith(
      target, expect.anything(), { deadline: startedAt + 10000 });
    expect(deps.gatewayProxyEngineService.forward.mock.calls[0][3]).toMatchObject({
      deadline: startedAt + 10000,
    });
  });

  it('C3 never reads or writes cache for network-leased requests even with a warm entry', async () => {
    const deps = createDeps();
    const target = networkTarget();
    deps.gatewayRouteSnapshotService.resolve.mockReturnValue(target);
    deps.gatewaySecurityService.authorize.mockResolvedValue({ mode: 'anonymous' });
    deps.gatewayTrafficControlService.admit.mockResolvedValue({ release: jest.fn() });
    deps.gatewayCacheService.resolve.mockReturnValue({
      key: 'cache-key', hit: true,
      entry: { statusCode: 200, headers: {}, responseBytes: 2, body: Buffer.from('ok') },
    });
    deps.gatewayProxyEngineService.requiresPreparation.mockReturnValue(true);
    deps.gatewayProxyEngineService.prepareRequest.mockResolvedValue(leasedPrepared());
    deps.gatewayProxyEngineService.forward.mockResolvedValue({
      statusCode: 200, headers: {}, targetUrl: 'https://api.example.com/orders',
    });

    await deps.service.forwardResolvedRoute(target as any, {
      method: 'GET',
      originalUrl: '/v1/gateway/orders',
      headers: { host: 'localhost:9001' },
    } as any, { setHeader: jest.fn() } as any);

    expect(deps.gatewayCacheService.resolve).not.toHaveBeenCalled();
    expect(deps.gatewayCacheService.store).not.toHaveBeenCalled();
    expect(deps.gatewayCacheService.writeHit).not.toHaveBeenCalled();
    expect(deps.gatewayProxyEngineService.forward).toHaveBeenCalledTimes(1);
  });
});
