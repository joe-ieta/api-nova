import { GatewayPolicyService } from './gateway-policy.service';

describe('GatewayPolicyService', () => {
  const service = new GatewayPolicyService();

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

  it('falls back to anonymous/meta_only/default timeout when refs are absent', () => {
    const result = service.compileForRoute({} as any);

    expect(result.auth.mode).toBe('anonymous');
    expect(result.logging.captureMode).toBe('meta_only');
    expect(result.traffic.timeoutMs).toBe(30000);
    expect(result.traffic.trafficControl).toBeUndefined();
    expect(result.cache.enabled).toBe(false);
  });
});
