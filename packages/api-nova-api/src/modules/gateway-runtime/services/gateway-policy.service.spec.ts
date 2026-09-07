import { GatewayPolicyService } from './gateway-policy.service';

describe('GatewayPolicyService', () => {
  const service = new GatewayPolicyService();

  it('fails closed for missing, unknown, and removed authentication modes', () => {
    expect(() => service.compileForRoute({} as any)).toThrow('Gateway authentication policy is required');
    expect(() => service.compileForRoute({ authPolicyRef: 'unknown-policy' } as any))
      .toThrow('Unsupported Gateway authentication policy');
    expect(() => service.compileForRoute({ authPolicyRef: 'oauth' } as any))
      .toThrow('Unsupported Gateway authentication policy');
    expect(() => service.compileForRoute({ authPolicyRef: 'runtime-api-key' } as any))
      .toThrow('Unsupported Gateway authentication policy');
  });

  it('keeps only explicit canonical authentication modes', () => {
    expect(service.compileForRoute({ authPolicyRef: 'anonymous', routeVisibility: 'external' } as any).auth.mode).toBe('anonymous');
    expect(service.compileForRoute({ authPolicyRef: 'jwt-default' } as any).auth.mode).toBe('jwt');
    expect(service.compileForRoute({ authPolicyRef: 'api-key-default' } as any).auth.mode).toBe('api_key');
  });

  it('compiles the route binding into a normalized policy bundle', () => {
    const result = service.compileForRoute({
      authPolicyRef: 'jwt-default',
      trafficPolicyRef: 'traffic-standard',
      loggingPolicyRef: 'body-preview',
      cachePolicyRef: 'cache-readonly',
      rateLimitPolicyRef: 'limit-standard',
      circuitBreakerPolicyRef: 'breaker-default',
      timeoutMs: 4500,
      retryPolicy: {
        attempts: 1,
      },
      upstreamConfig: {
        preserveHost: true,
        cache: {
          ttlMs: 15000,
          maxBodyBytes: 4096,
          varyQueryKeys: ['tenant'],
          varyHeaderKeys: ['accept-language'],
          varyByConsumer: true,
        },
        trafficControl: {
          breaker: {
            failureThreshold: 3,
            cooldownMs: 1000,
          },
        },
      },
    } as any);

    expect(result).toEqual({
      auth: {
        apiKeyQueryParamName: undefined,
        ref: 'jwt-default',
        mode: 'jwt',
      },
      traffic: {
        ref: 'traffic-standard',
        timeoutMs: 4500,
        retryPolicy: {
          attempts: 1,
        },
        rateLimitRef: 'limit-standard',
        circuitBreakerRef: 'breaker-default',
        trafficControl: {
          rateLimit: undefined,
          concurrency: undefined,
          breaker: {
            failureThreshold: 3,
            cooldownMs: 1000,
            halfOpenMax: undefined,
          },
        },
      },
      logging: {
        ref: 'body-preview',
        captureMode: 'body_preview',
      },
      cache: {
        ref: 'cache-readonly',
        enabled: true,
        methods: ['GET', 'HEAD'],
        ttlMs: 15000,
        maxBodyBytes: 4096,
        varyQueryKeys: ['tenant'],
        varyHeaderKeys: ['accept-language'],
        varyByConsumer: true,
      },
      upstream: {
        raw: {
          preserveHost: true,
          cache: {
            ttlMs: 15000,
            maxBodyBytes: 4096,
            varyQueryKeys: ['tenant'],
            varyHeaderKeys: ['accept-language'],
            varyByConsumer: true,
          },
          trafficControl: {
            breaker: {
              failureThreshold: 3,
              cooldownMs: 1000,
            },
          },
        },
      },
    });
  });

  it('keeps non-auth defaults when anonymous is explicitly selected', () => {
    const result = service.compileForRoute({ authPolicyRef: 'anonymous', routeVisibility: 'external' } as any);

    expect(result.auth.mode).toBe('anonymous');
    expect(result.logging.captureMode).toBe('meta_only');
    expect(result.traffic.timeoutMs).toBe(30000);
    expect(result.traffic.trafficControl).toBeUndefined();
    expect(result.cache.enabled).toBe(false);
  });

  it.each(['internal', undefined, 'unexpected'])(
    'compiles protected access for non-external visibility %s', routeVisibility => {
      expect(service.compileForRoute({
        authPolicyRef: 'anonymous', routeVisibility,
      } as any).auth.mode).toBe('jwt');
    },
  );

});
