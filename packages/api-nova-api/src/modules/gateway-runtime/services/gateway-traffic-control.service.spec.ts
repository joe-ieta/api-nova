import {
  HttpException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { GatewayTrafficControlService } from './gateway-traffic-control.service';

describe('GatewayTrafficControlService', () => {
  const buildService = () => {
    const runtimeObservabilityService = {
      recordRuntimeControlEvent: jest.fn().mockResolvedValue(undefined),
    };
    const gatewayRuntimeMetricsService = {
      recordPolicyEvent: jest.fn(),
    };
    return new GatewayTrafficControlService(
      runtimeObservabilityService as any,
      gatewayRuntimeMetricsService as any,
    );
  };

  const resolvedRoute = () =>
    ({
      runtimeAsset: { id: 'runtime-1' },
      membership: { id: 'membership-1' },
      routeBinding: {
        id: 'route-1',
        routePath: '/orders',
        routeMethod: 'GET',
      },
      policies: {
        traffic: {
          trafficControl: {
            rateLimit: {
              windowMs: 1000,
              routeMax: 1,
              consumerMax: 1,
            },
            concurrency: {
              routeMax: 1,
            },
          },
        },
      },
    } as any);

  it('rejects repeated requests after the configured route limit is exceeded', async () => {
    const service = buildService();
    const route = resolvedRoute();

    await expect(
      service.admit(route, {
        mode: 'anonymous',
      }),
    ).resolves.toEqual(expect.objectContaining({ release: expect.any(Function) }));

    await expect(
      service.admit(route, {
        mode: 'anonymous',
      }),
    ).rejects.toThrow(HttpException);
  });

  it('enforces consumer-scoped rate limits when consumer identity exists', async () => {
    const service = buildService();
    const route = resolvedRoute();
    const auth = {
      mode: 'api_key' as const,
      consumerId: 'consumer-1',
    };

    await service.admit(route, auth);
    await expect(service.admit(route, auth)).rejects.toThrow(HttpException);
  });

  it('releases concurrency counters after the request completes', async () => {
    const service = buildService();
    const route = resolvedRoute();
    route.policies.traffic.trafficControl.rateLimit = undefined;

    const first = await service.admit(route, {
      mode: 'anonymous',
    });

    await expect(
      service.admit(route, {
        mode: 'anonymous',
      }),
    ).rejects.toThrow(ServiceUnavailableException);

    first.release();

    await expect(
      service.admit(route, {
        mode: 'anonymous',
      }),
    ).resolves.toEqual(expect.objectContaining({ release: expect.any(Function) }));
  });

  it('opens the breaker after repeated failures and recovers after a successful probe', async () => {
    jest.useFakeTimers();
    const runtimeObservabilityService = {
      recordRuntimeControlEvent: jest.fn().mockResolvedValue(undefined),
    };
    const gatewayRuntimeMetricsService = {
      recordPolicyEvent: jest.fn(),
    };
    const service = new GatewayTrafficControlService(
      runtimeObservabilityService as any,
      gatewayRuntimeMetricsService as any,
    );
    const route = resolvedRoute();
    route.policies.traffic.trafficControl = {
      breaker: {
        failureThreshold: 2,
        cooldownMs: 1000,
        halfOpenMax: 1,
      },
    };

    await service.beforeAttempt(route);
    await service.recordAttemptFailure(route, new Error('failure-1'));
    await service.beforeAttempt(route);
    await service.recordAttemptFailure(route, new Error('failure-2'));

    await expect(service.beforeAttempt(route)).rejects.toThrow(ServiceUnavailableException);

    jest.advanceTimersByTime(1001);
    await expect(service.beforeAttempt(route)).resolves.toBeUndefined();
    await service.recordAttemptSuccess(route);
    await expect(service.beforeAttempt(route)).resolves.toBeUndefined();
    jest.useRealTimers();
  });

  it('rejects extra half-open probes beyond the configured limit', async () => {
    jest.useFakeTimers();
    const runtimeObservabilityService = {
      recordRuntimeControlEvent: jest.fn().mockResolvedValue(undefined),
    };
    const gatewayRuntimeMetricsService = {
      recordPolicyEvent: jest.fn(),
    };
    const service = new GatewayTrafficControlService(
      runtimeObservabilityService as any,
      gatewayRuntimeMetricsService as any,
    );
    const route = resolvedRoute();
    route.policies.traffic.trafficControl = {
      breaker: {
        failureThreshold: 1,
        cooldownMs: 1000,
        halfOpenMax: 1,
      },
    };

    await service.beforeAttempt(route);
    await service.recordAttemptFailure(route, new Error('failure-1'));

    jest.advanceTimersByTime(1001);
    await expect(service.beforeAttempt(route)).resolves.toBeUndefined();
    await expect(service.beforeAttempt(route)).rejects.toThrow(ServiceUnavailableException);
    jest.useRealTimers();
  });
});
