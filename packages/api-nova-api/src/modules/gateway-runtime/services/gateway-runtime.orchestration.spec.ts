import { UnauthorizedException, ServiceUnavailableException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { createHash } from 'node:crypto';
import { GatewayConsumerCredentialStatus } from '../../../database/entities/gateway-consumer-credential.entity';
import { GatewayCacheService } from './gateway-cache.service';
import { GatewayRuntimeMetricsService } from './gateway-runtime-metrics.service';
import { GatewayRuntimeService } from './gateway-runtime.service';
import { GatewaySecurityService } from './gateway-security.service';
import { GatewayTrafficControlService } from './gateway-traffic-control.service';

class MockResponse {
  public statusCode = 200;
  public headersSent = false;
  public body = Buffer.alloc(0);
  private readonly headers = new Map<string, string | string[]>();

  status(code: number) {
    this.statusCode = code;
    return this;
  }

  setHeader(name: string, value: string | string[]) {
    this.headers.set(name.toLowerCase(), value);
  }

  getHeader(name: string) {
    return this.headers.get(name.toLowerCase());
  }

  end(payload?: Buffer | string) {
    this.headersSent = true;
    if (payload === undefined) {
      return;
    }
    this.body = Buffer.isBuffer(payload) ? Buffer.from(payload) : Buffer.from(payload, 'utf8');
  }

  bodyAsText() {
    return this.body.toString('utf8');
  }
}

const createRequest = (input: {
  method: string;
  originalUrl: string;
  headers?: Record<string, string>;
  query?: Record<string, unknown>;
}) =>
  ({
    method: input.method,
    originalUrl: input.originalUrl,
    url: input.originalUrl,
    headers: input.headers || {},
    query: input.query || {},
    socket: { remoteAddress: '127.0.0.1' },
  }) as any;

const createResolvedRoute = (overrides: Record<string, any> = {}) =>
  ({
    runtimeAsset: { id: 'runtime-1' },
    membership: { id: 'membership-1' },
    endpointDefinition: { id: 'endpoint-1' },
    publishBinding: { id: 'publish-1', publishedToHttp: true },
    sourceServiceAsset: { id: 'source-1' },
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
      traffic: {
        retryPolicy: { attempts: 1 },
      },
      logging: { captureMode: 'body_preview' },
      cache: {
        enabled: false,
        methods: ['GET', 'HEAD'],
      },
      upstream: {},
    },
    ...overrides,
  }) as any;

const createProxySuccess = (overrides: Record<string, any> = {}) => ({
  statusCode: 200,
  headers: { 'content-type': 'application/json' },
  targetUrl: 'https://api.example.com/orders',
  responseBodyBuffer: Buffer.from('{"ok":true}', 'utf8'),
  responseCapture: {
    totalBytes: 11,
    preview: '{"ok":true}',
    hash: 'hash-ok',
    truncated: false,
  },
  requestCapture: {
    totalBytes: 0,
    hash: 'hash-req',
    truncated: false,
  },
  ...overrides,
});

describe('GatewayRuntimeService orchestration', () => {
  const buildHarness = (routeOverrides: Record<string, any> = {}) => {
    const resolvedRoute = createResolvedRoute(routeOverrides);
    const snapshotService = {
      resolve: jest.fn().mockReturnValue(resolvedRoute),
    };
    const jwtService = {
      verify: jest.fn(),
    };
    const userService = {
      findUserById: jest.fn(),
    };
    const auditService = {
      log: jest.fn().mockResolvedValue(undefined),
    };
    const credentialRepository = {
      findOne: jest.fn(),
      save: jest.fn(async value => value),
    };
    const runtimeObservabilityService = {
      recordGatewayRequestResult: jest.fn().mockResolvedValue(undefined),
      recordGatewayCacheResult: jest.fn().mockResolvedValue(undefined),
      recordRuntimeControlEvent: jest.fn().mockResolvedValue(undefined),
    };
    const accessLogService = {
      recordRequest: jest.fn().mockResolvedValue(undefined),
    };
    const proxyEngineService = {
      forward: jest.fn(),
    };

    const metricsService = new GatewayRuntimeMetricsService(runtimeObservabilityService as any);
    const securityService = new GatewaySecurityService(
      jwtService as unknown as JwtService,
      userService as any,
      auditService as any,
      credentialRepository as any,
    );
    const trafficControlService = new GatewayTrafficControlService(
      runtimeObservabilityService as any,
      metricsService,
    );
    const cacheService = new GatewayCacheService();
    const runtimeService = new GatewayRuntimeService(
      snapshotService as any,
      securityService,
      trafficControlService,
      cacheService,
      proxyEngineService as any,
      accessLogService as any,
      metricsService,
    );

    return {
      resolvedRoute,
      snapshotService,
      jwtService,
      userService,
      credentialRepository,
      runtimeObservabilityService,
      accessLogService,
      proxyEngineService,
      metricsService,
      cacheService,
      runtimeService,
    };
  };

  it('authorizes JWT routes and proxies successfully', async () => {
    const harness = buildHarness({
      policies: {
        auth: { mode: 'jwt' },
        traffic: { retryPolicy: { attempts: 1 } },
        logging: { captureMode: 'body_preview' },
        cache: { enabled: false, methods: ['GET', 'HEAD'] },
        upstream: {},
      },
    });
    harness.jwtService.verify.mockReturnValue({ sub: 'user-1' });
    harness.userService.findUserById.mockResolvedValue({ id: 'user-1', isActive: true });
    harness.proxyEngineService.forward.mockResolvedValue(createProxySuccess());

    const req = createRequest({
      method: 'GET',
      originalUrl: '/api/v1/gateway/orders',
      headers: {
        host: 'gateway.local',
        authorization: 'Bearer token-123',
        'x-request-id': 'req-jwt-success',
      },
    });
    const res = new MockResponse();

    await harness.runtimeService.forwardRequest('/orders', req, res as any);

    expect(req.user).toEqual({ id: 'user-1', isActive: true });
    expect(req.gatewayAuth).toEqual({ mode: 'jwt', actorId: 'user-1' });
    expect(harness.proxyEngineService.forward).toHaveBeenCalledTimes(1);
    expect(harness.runtimeObservabilityService.recordGatewayRequestResult).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'req-jwt-success',
        success: true,
        statusCode: 200,
      }),
    );
  });

  it('rejects JWT routes without a token before reaching upstream', async () => {
    const harness = buildHarness({
      policies: {
        auth: { mode: 'jwt' },
        traffic: { retryPolicy: { attempts: 1 } },
        logging: { captureMode: 'body_preview' },
        cache: { enabled: false, methods: ['GET', 'HEAD'] },
        upstream: {},
      },
    });

    await expect(
      harness.runtimeService.forwardRequest(
        '/orders',
        createRequest({
          method: 'GET',
          originalUrl: '/api/v1/gateway/orders',
          headers: {
            host: 'gateway.local',
            'x-request-id': 'req-jwt-failed',
          },
        }),
        new MockResponse() as any,
      ),
    ).rejects.toThrow(UnauthorizedException);

    expect(harness.proxyEngineService.forward).not.toHaveBeenCalled();
    expect(harness.metricsService.getRuntimeAssetMetrics('runtime-1').policyCounts).toEqual(
      expect.objectContaining({
        'gateway.auth_rejected': 1,
      }),
    );
  });

  it('accepts valid API keys and rejects invalid ones', async () => {
    const harness = buildHarness({
      policies: {
        auth: { mode: 'api_key' },
        traffic: { retryPolicy: { attempts: 1 } },
        logging: { captureMode: 'body_preview' },
        cache: { enabled: false, methods: ['GET', 'HEAD'] },
        upstream: {},
      },
    });
    harness.credentialRepository.findOne.mockResolvedValue({
      id: 'consumer-1',
      keyId: 'key-live',
      secretHash: createHash('sha256').update('secret-live').digest('hex'),
      status: GatewayConsumerCredentialStatus.ACTIVE,
      runtimeAssetId: 'runtime-1',
    });
    harness.proxyEngineService.forward.mockResolvedValue(createProxySuccess());

    const successReq = createRequest({
      method: 'GET',
      originalUrl: '/api/v1/gateway/orders',
      headers: {
        host: 'gateway.local',
        'x-api-key': 'key-live.secret-live',
        'x-request-id': 'req-apikey-success',
      },
    });

    await harness.runtimeService.forwardRequest('/orders', successReq, new MockResponse() as any);
    expect(successReq.gatewayAuth).toEqual({
      mode: 'api_key',
      consumerId: 'consumer-1',
      keyId: 'key-live',
    });

    harness.proxyEngineService.forward.mockClear();
    harness.credentialRepository.findOne.mockResolvedValue({
      id: 'consumer-1',
      keyId: 'key-live',
      secretHash: createHash('sha256').update('different-secret').digest('hex'),
      status: GatewayConsumerCredentialStatus.ACTIVE,
      runtimeAssetId: 'runtime-1',
    });

    await expect(
      harness.runtimeService.forwardRequest(
        '/orders',
        createRequest({
          method: 'GET',
          originalUrl: '/api/v1/gateway/orders',
          headers: {
            host: 'gateway.local',
            'x-api-key': 'key-live.secret-live',
            'x-request-id': 'req-apikey-failed',
          },
        }),
        new MockResponse() as any,
      ),
    ).rejects.toThrow('Gateway API key is invalid');

    expect(harness.proxyEngineService.forward).not.toHaveBeenCalled();
  });

  it('enforces route-level rate limits across requests', async () => {
    const harness = buildHarness({
      policies: {
        auth: { mode: 'anonymous' },
        traffic: {
          retryPolicy: { attempts: 1 },
          trafficControl: {
            rateLimit: {
              windowMs: 1000,
              routeMax: 1,
            },
          },
        },
        logging: { captureMode: 'body_preview' },
        cache: { enabled: false, methods: ['GET', 'HEAD'] },
        upstream: {},
      },
    });
    harness.proxyEngineService.forward.mockResolvedValue(createProxySuccess());

    await harness.runtimeService.forwardRequest(
      '/orders',
      createRequest({
        method: 'GET',
        originalUrl: '/api/v1/gateway/orders',
        headers: { host: 'gateway.local', 'x-request-id': 'req-rate-1' },
      }),
      new MockResponse() as any,
    );

    await expect(
      harness.runtimeService.forwardRequest(
        '/orders',
        createRequest({
          method: 'GET',
          originalUrl: '/api/v1/gateway/orders',
          headers: { host: 'gateway.local', 'x-request-id': 'req-rate-2' },
        }),
        new MockResponse() as any,
      ),
    ).rejects.toThrow('Gateway rate limit exceeded');

    expect(harness.proxyEngineService.forward).toHaveBeenCalledTimes(1);
    expect(harness.metricsService.getRuntimeAssetMetrics('runtime-1').policyCounts).toEqual(
      expect.objectContaining({
        'gateway.rate_limit_rejected': 1,
      }),
    );
  });

  it('rejects concurrent requests before the first one releases its admission slot', async () => {
    const harness = buildHarness({
      policies: {
        auth: { mode: 'anonymous' },
        traffic: {
          retryPolicy: { attempts: 1 },
          trafficControl: {
            concurrency: {
              routeMax: 1,
            },
          },
        },
        logging: { captureMode: 'body_preview' },
        cache: { enabled: false, methods: ['GET', 'HEAD'] },
        upstream: {},
      },
    });

    let releaseFirstAttempt!: (value: any) => void;
    const firstProxyPromise = new Promise(resolve => {
      releaseFirstAttempt = resolve;
    });
    harness.proxyEngineService.forward
      .mockReturnValueOnce(firstProxyPromise)
      .mockResolvedValueOnce(createProxySuccess());

    const firstRequest = harness.runtimeService.forwardRequest(
      '/orders',
      createRequest({
        method: 'GET',
        originalUrl: '/api/v1/gateway/orders',
        headers: { host: 'gateway.local', 'x-request-id': 'req-concurrency-1' },
      }),
      new MockResponse() as any,
    );

    await expect(
      harness.runtimeService.forwardRequest(
        '/orders',
        createRequest({
          method: 'GET',
          originalUrl: '/api/v1/gateway/orders',
          headers: { host: 'gateway.local', 'x-request-id': 'req-concurrency-2' },
        }),
        new MockResponse() as any,
      ),
    ).rejects.toThrow('Gateway concurrency limit exceeded');

    releaseFirstAttempt(createProxySuccess());
    await firstRequest;

    expect(harness.metricsService.getRuntimeAssetMetrics('runtime-1').policyCounts).toEqual(
      expect.objectContaining({
        'gateway.concurrency_rejected': 1,
      }),
    );
  });

  it('retries idempotent requests under safe retry policy', async () => {
    jest.useFakeTimers();
    try {
      const harness = buildHarness({
        policies: {
          auth: { mode: 'anonymous' },
          traffic: {
            retryPolicy: { attempts: 2 },
            trafficControl: {
              breaker: {
                failureThreshold: 2,
                cooldownMs: 1000,
                halfOpenMax: 1,
              },
            },
          },
          logging: { captureMode: 'body_preview' },
          cache: { enabled: false, methods: ['GET', 'HEAD'] },
          upstream: {},
        },
      });

      harness.proxyEngineService.forward
        .mockRejectedValueOnce(new Error('temporary upstream error'))
        .mockResolvedValueOnce(createProxySuccess({ targetUrl: 'https://api.example.com/orders?retry=1' }));

      const retryPromise = harness.runtimeService.forwardRequest(
        '/orders',
        createRequest({
          method: 'GET',
          originalUrl: '/api/v1/gateway/orders',
          headers: { host: 'gateway.local', 'x-request-id': 'req-retry' },
        }),
        new MockResponse() as any,
      );
      await jest.runAllTimersAsync();
      await retryPromise;

      expect(harness.proxyEngineService.forward).toHaveBeenCalledTimes(2);
      expect(harness.metricsService.getRuntimeAssetMetrics('runtime-1').policyCounts).toEqual(
        expect.objectContaining({
          'gateway.retry_attempt': 1,
        }),
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('opens the breaker after repeated failures and rejects the next request', async () => {
    const harness = buildHarness({
      policies: {
        auth: { mode: 'anonymous' },
        traffic: {
          retryPolicy: { attempts: 1 },
          trafficControl: {
            breaker: {
              failureThreshold: 1,
              cooldownMs: 1000,
              halfOpenMax: 1,
            },
          },
        },
        logging: { captureMode: 'body_preview' },
        cache: { enabled: false, methods: ['GET', 'HEAD'] },
        upstream: {},
      },
    });
    harness.proxyEngineService.forward.mockRejectedValue(new Error('fatal upstream error'));

    await expect(
      harness.runtimeService.forwardRequest(
        '/orders',
        createRequest({
          method: 'GET',
          originalUrl: '/api/v1/gateway/orders',
          headers: { host: 'gateway.local', 'x-request-id': 'req-breaker-open-1' },
        }),
        new MockResponse() as any,
      ),
    ).rejects.toThrow('fatal upstream error');

    await expect(
      harness.runtimeService.forwardRequest(
        '/orders',
        createRequest({
          method: 'GET',
          originalUrl: '/api/v1/gateway/orders',
          headers: { host: 'gateway.local', 'x-request-id': 'req-breaker-open-2' },
        }),
        new MockResponse() as any,
      ),
    ).rejects.toThrow(ServiceUnavailableException);

    expect(harness.proxyEngineService.forward).toHaveBeenCalledTimes(1);
    expect(harness.metricsService.getRuntimeAssetMetrics('runtime-1').policyCounts).toEqual(
      expect.objectContaining({
        'gateway.breaker_open': 1,
      }),
    );
  });

  it('serves GET cache hits after the first successful upstream response', async () => {
    const harness = buildHarness({
      policies: {
        auth: { mode: 'anonymous' },
        traffic: { retryPolicy: { attempts: 1 } },
        logging: { captureMode: 'body_preview' },
        cache: {
          enabled: true,
          methods: ['GET', 'HEAD'],
          ttlMs: 1000,
          maxBodyBytes: 1024,
        },
        upstream: {},
      },
    });
    harness.proxyEngineService.forward.mockResolvedValue(
      createProxySuccess({
        responseBodyBuffer: Buffer.from('{"cached":true}', 'utf8'),
        responseCapture: {
          totalBytes: 15,
          preview: '{"cached":true}',
          hash: 'hash-cached',
          truncated: false,
        },
      }),
    );

    const firstRes = new MockResponse();
    await harness.runtimeService.forwardRequest(
      '/orders',
      createRequest({
        method: 'GET',
        originalUrl: '/api/v1/gateway/orders',
        headers: { host: 'gateway.local', 'x-request-id': 'req-cache-miss' },
      }),
      firstRes as any,
    );

    const secondRes = new MockResponse();
    await harness.runtimeService.forwardRequest(
      '/orders',
      createRequest({
        method: 'GET',
        originalUrl: '/api/v1/gateway/orders',
        headers: { host: 'gateway.local', 'x-request-id': 'req-cache-hit' },
      }),
      secondRes as any,
    );

    expect(harness.proxyEngineService.forward).toHaveBeenCalledTimes(1);
    expect(secondRes.getHeader('x-apinova-cache')).toBe('HIT');
    expect(secondRes.bodyAsText()).toBe('{"cached":true}');
    expect(harness.runtimeObservabilityService.recordGatewayCacheResult).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'req-cache-miss',
        cacheStatus: 'miss',
      }),
    );
    expect(harness.runtimeObservabilityService.recordGatewayCacheResult).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'req-cache-hit',
        cacheStatus: 'hit',
      }),
    );
  });
});
