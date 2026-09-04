import { GatewayRuntimeMetricsService } from './gateway-runtime-metrics.service';

describe('GatewayRuntimeMetricsService', () => {
  it('tracks cache hits and policy counters in runtime metrics state', async () => {
    const runtimeObservabilityService = {
      recordGatewayRequestResult: jest.fn().mockResolvedValue(undefined),
      recordGatewayCacheResult: jest.fn().mockResolvedValue(undefined),
      recordGatewayRouteMiss: jest.fn().mockResolvedValue(undefined),
      recordRuntimeControlEvent: jest.fn().mockResolvedValue(undefined),
    };
    const service = new GatewayRuntimeMetricsService(runtimeObservabilityService as any);

    await service.recordForwardResult({
      runtimeAssetId: 'runtime-1',
      runtimeMembershipId: 'membership-1',
      routePath: '/orders',
      routeMethod: 'GET',
      latencyMs: 12,
      success: true,
      statusCode: 200,
    });
    await service.recordCacheResult({
      runtimeAssetId: 'runtime-1',
      runtimeMembershipId: 'membership-1',
      routePath: '/orders',
      routeMethod: 'GET',
      cacheStatus: 'hit',
    });
    service.recordPolicyEvent({
      runtimeAssetId: 'runtime-1',
      runtimeMembershipId: 'membership-1',
      routePath: '/orders',
      routeMethod: 'GET',
      policyName: 'gateway.rate_limit_rejected',
    });

    const metrics = service.getRuntimeAssetMetrics('runtime-1');

    expect(metrics.cacheHitCount).toBe(1);
    expect(metrics.policyCounts['gateway.rate_limit_rejected']).toBe(1);
    expect(metrics.routes[0]).toEqual(
      expect.objectContaining({
        routePath: '/orders',
        cacheHitCount: 1,
        policyCounts: {
          'gateway.rate_limit_rejected': 1,
        },
      }),
    );
  });

  it('writes unmatched route misses to runtime observability', async () => {
    const runtimeObservabilityService = {
      recordGatewayRequestResult: jest.fn().mockResolvedValue(undefined),
      recordGatewayCacheResult: jest.fn().mockResolvedValue(undefined),
      recordGatewayRouteMiss: jest.fn().mockResolvedValue(undefined),
      recordRuntimeControlEvent: jest.fn().mockResolvedValue(undefined),
    };
    const service = new GatewayRuntimeMetricsService(runtimeObservabilityService as any);

    await service.recordRouteMiss({
      method: 'GET',
      routePath: '/missing',
      host: 'gateway.local',
      requestId: 'req-miss',
    });

    expect(runtimeObservabilityService.recordGatewayRouteMiss).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'GET',
        routePath: '/missing',
        host: 'gateway.local',
        requestId: 'req-miss',
      }),
    );
  });
});
