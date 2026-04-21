import {
  HttpException,
  HttpStatus,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  RuntimeObservabilityEventFamily,
  RuntimeObservabilitySeverity,
  RuntimeObservabilityStatus,
} from '../../../database/entities/runtime-observability-event.entity';
import { RuntimeObservabilityService } from '../../runtime-observability/services/runtime-observability.service';
import { GatewayResolvedRoute } from '../types/gateway-route-snapshot.types';
import { GatewayRequestAuthContext } from '../types/gateway-security.types';
import {
  GatewayBreakerState,
  GatewayTrafficAdmission,
} from '../types/gateway-traffic.types';
import { GatewayRuntimeMetricsService } from './gateway-runtime-metrics.service';

type CounterState = {
  windowStartedAt: number;
  count: number;
};

type BreakerRuntimeState = {
  state: GatewayBreakerState;
  consecutiveFailures: number;
  openedAt?: number;
  halfOpenInFlight: number;
};

@Injectable()
export class GatewayTrafficControlService {
  private readonly rateLimitCounters = new Map<string, CounterState>();
  private readonly concurrencyCounters = new Map<string, number>();
  private readonly breakerStates = new Map<string, BreakerRuntimeState>();

  constructor(
    private readonly runtimeObservabilityService: RuntimeObservabilityService,
    private readonly gatewayRuntimeMetricsService: GatewayRuntimeMetricsService,
  ) {}

  async admit(
    resolvedRoute: GatewayResolvedRoute,
    authContext?: GatewayRequestAuthContext,
  ): Promise<GatewayTrafficAdmission> {
    const trafficControl = resolvedRoute.policies.traffic.trafficControl;
    if (!trafficControl) {
      return { release: () => undefined };
    }

    await this.beforeAttempt(resolvedRoute);
    this.enforceRateLimit(resolvedRoute, authContext);
    return this.acquireConcurrency(resolvedRoute, authContext);
  }

  async beforeAttempt(resolvedRoute: GatewayResolvedRoute) {
    const breaker = resolvedRoute.policies.traffic.trafficControl?.breaker;
    if (!breaker) {
      return;
    }

    const key = this.breakerKey(resolvedRoute);
    const now = Date.now();
    const state = this.breakerStates.get(key) || {
      state: 'closed' as GatewayBreakerState,
      consecutiveFailures: 0,
      halfOpenInFlight: 0,
    };

    if (state.state === 'open') {
      const canProbe = state.openedAt && now - state.openedAt >= breaker.cooldownMs;
      if (!canProbe) {
        throw new ServiceUnavailableException('Gateway circuit breaker is open');
      }
      state.state = 'half_open';
      state.halfOpenInFlight = 0;
      await this.emitPolicyEvent(resolvedRoute, 'gateway.breaker_half_open', {
        severity: RuntimeObservabilitySeverity.INFO,
        status: RuntimeObservabilityStatus.ACTIVE,
        breakerState: state.state,
      });
    }

    if (state.state === 'half_open') {
      const halfOpenMax = breaker.halfOpenMax || 1;
      if (state.halfOpenInFlight >= halfOpenMax) {
        throw new ServiceUnavailableException('Gateway circuit breaker is probing upstream');
      }
      state.halfOpenInFlight += 1;
    }

    this.breakerStates.set(key, state);
  }

  async recordAttemptSuccess(resolvedRoute: GatewayResolvedRoute) {
    const breaker = resolvedRoute.policies.traffic.trafficControl?.breaker;
    if (!breaker) {
      return;
    }

    const key = this.breakerKey(resolvedRoute);
    const state = this.breakerStates.get(key);
    if (!state) {
      return;
    }

    const wasHalfOpen = state.state === 'half_open' || state.state === 'open';
    state.state = 'closed';
    state.consecutiveFailures = 0;
    state.openedAt = undefined;
    state.halfOpenInFlight = 0;
    this.breakerStates.set(key, state);

    if (wasHalfOpen) {
      await this.emitPolicyEvent(resolvedRoute, 'gateway.breaker_recovered', {
        severity: RuntimeObservabilitySeverity.INFO,
        status: RuntimeObservabilityStatus.SUCCESS,
        breakerState: state.state,
      });
    }
  }

  async recordAttemptFailure(
    resolvedRoute: GatewayResolvedRoute,
    error: Error,
  ) {
    const breaker = resolvedRoute.policies.traffic.trafficControl?.breaker;
    if (!breaker) {
      return;
    }

    const key = this.breakerKey(resolvedRoute);
    const state = this.breakerStates.get(key) || {
      state: 'closed' as GatewayBreakerState,
      consecutiveFailures: 0,
      halfOpenInFlight: 0,
    };

    if (state.state === 'half_open' && state.halfOpenInFlight > 0) {
      state.halfOpenInFlight -= 1;
    }

    state.consecutiveFailures += 1;
    if (state.state === 'half_open' || state.consecutiveFailures >= breaker.failureThreshold) {
      state.state = 'open';
      state.openedAt = Date.now();
      state.halfOpenInFlight = 0;
      await this.emitPolicyEvent(resolvedRoute, 'gateway.breaker_open', {
        severity: RuntimeObservabilitySeverity.WARNING,
        status: RuntimeObservabilityStatus.FAILED,
        breakerState: state.state,
        consecutiveFailures: state.consecutiveFailures,
        errorMessage: error.message,
      });
    }

    this.breakerStates.set(key, state);
  }

  async recordRetryAttempt(
    resolvedRoute: GatewayResolvedRoute,
    attempt: number,
    error: Error,
  ) {
    await this.emitPolicyEvent(resolvedRoute, 'gateway.retry_attempt', {
      severity: RuntimeObservabilitySeverity.INFO,
      status: RuntimeObservabilityStatus.ACTIVE,
      attempt,
      errorMessage: error.message,
    });
  }

  private enforceRateLimit(
    resolvedRoute: GatewayResolvedRoute,
    authContext?: GatewayRequestAuthContext,
  ) {
    const rateLimit = resolvedRoute.policies.traffic.trafficControl?.rateLimit;
    if (!rateLimit) {
      return;
    }

    const now = Date.now();
    const checks = [
      rateLimit.globalMax
        ? { key: 'global', limit: rateLimit.globalMax }
        : undefined,
      rateLimit.runtimeAssetMax
        ? {
            key: `runtime:${resolvedRoute.runtimeAsset.id}`,
            limit: rateLimit.runtimeAssetMax,
          }
        : undefined,
      rateLimit.routeMax
        ? {
            key: `route:${resolvedRoute.routeBinding.id}`,
            limit: rateLimit.routeMax,
          }
        : undefined,
      rateLimit.consumerMax && authContext?.consumerId
        ? {
            key: `consumer:${resolvedRoute.routeBinding.id}:${authContext.consumerId}`,
            limit: rateLimit.consumerMax,
          }
        : undefined,
    ].filter((item): item is { key: string; limit: number } => Boolean(item));

    const touched: Array<{ key: string; nextState: CounterState }> = [];
    for (const check of checks) {
      const current = this.rateLimitCounters.get(check.key);
      const activeWindow =
        current && now - current.windowStartedAt < rateLimit.windowMs
          ? current
          : { windowStartedAt: now, count: 0 };
      if (activeWindow.count + 1 > check.limit) {
        void this.runtimeObservabilityService.recordRuntimeControlEvent({
          runtimeAssetId: resolvedRoute.runtimeAsset.id,
          runtimeMembershipId: resolvedRoute.membership.id,
          eventFamily: RuntimeObservabilityEventFamily.RUNTIME_POLICY,
          eventName: 'gateway.rate_limit_rejected',
          severity: RuntimeObservabilitySeverity.WARNING,
          status: RuntimeObservabilityStatus.FAILED,
          summary: `${resolvedRoute.routeBinding.routeMethod} ${resolvedRoute.routeBinding.routePath} rate limited`,
          details: {
            limitKey: check.key,
            limit: check.limit,
            windowMs: rateLimit.windowMs,
            consumerId: authContext?.consumerId,
          },
          dimensions: {
            routePath: resolvedRoute.routeBinding.routePath,
            routeMethod: resolvedRoute.routeBinding.routeMethod,
            limitKey: check.key,
          },
        });
        this.gatewayRuntimeMetricsService.recordPolicyEvent({
          runtimeAssetId: resolvedRoute.runtimeAsset.id,
          runtimeMembershipId: resolvedRoute.membership.id,
          routePath: resolvedRoute.routeBinding.routePath,
          routeMethod: resolvedRoute.routeBinding.routeMethod,
          policyName: 'gateway.rate_limit_rejected',
        });
        throw new HttpException('Gateway rate limit exceeded', HttpStatus.TOO_MANY_REQUESTS);
      }
      touched.push({
        key: check.key,
        nextState: {
          windowStartedAt: activeWindow.windowStartedAt,
          count: activeWindow.count + 1,
        },
      });
    }

    for (const item of touched) {
      this.rateLimitCounters.set(item.key, item.nextState);
    }
  }

  private acquireConcurrency(
    resolvedRoute: GatewayResolvedRoute,
    authContext?: GatewayRequestAuthContext,
  ): GatewayTrafficAdmission {
    const concurrency = resolvedRoute.policies.traffic.trafficControl?.concurrency;
    if (!concurrency) {
      return { release: () => undefined };
    }

    const keys: Array<{ key: string; limit: number }> = [];
    if (concurrency.runtimeAssetMax) {
      keys.push({
        key: `runtime:${resolvedRoute.runtimeAsset.id}`,
        limit: concurrency.runtimeAssetMax,
      });
    }
    if (concurrency.routeMax) {
      keys.push({
        key: `route:${resolvedRoute.routeBinding.id}`,
        limit: concurrency.routeMax,
      });
    }

    for (const key of keys) {
      const current = this.concurrencyCounters.get(key.key) || 0;
      if (current + 1 > key.limit) {
        void this.runtimeObservabilityService.recordRuntimeControlEvent({
          runtimeAssetId: resolvedRoute.runtimeAsset.id,
          runtimeMembershipId: resolvedRoute.membership.id,
          eventFamily: RuntimeObservabilityEventFamily.RUNTIME_POLICY,
          eventName: 'gateway.concurrency_rejected',
          severity: RuntimeObservabilitySeverity.WARNING,
          status: RuntimeObservabilityStatus.FAILED,
          summary: `${resolvedRoute.routeBinding.routeMethod} ${resolvedRoute.routeBinding.routePath} concurrency limited`,
          details: {
            limitKey: key.key,
            limit: key.limit,
            consumerId: authContext?.consumerId,
          },
          dimensions: {
            routePath: resolvedRoute.routeBinding.routePath,
            routeMethod: resolvedRoute.routeBinding.routeMethod,
            limitKey: key.key,
          },
        });
        this.gatewayRuntimeMetricsService.recordPolicyEvent({
          runtimeAssetId: resolvedRoute.runtimeAsset.id,
          runtimeMembershipId: resolvedRoute.membership.id,
          routePath: resolvedRoute.routeBinding.routePath,
          routeMethod: resolvedRoute.routeBinding.routeMethod,
          policyName: 'gateway.concurrency_rejected',
        });
        throw new ServiceUnavailableException('Gateway concurrency limit exceeded');
      }
    }

    for (const key of keys) {
      this.concurrencyCounters.set(key.key, (this.concurrencyCounters.get(key.key) || 0) + 1);
    }

    let released = false;
    return {
      release: () => {
        if (released) {
          return;
        }
        released = true;
        for (const key of keys) {
          const current = this.concurrencyCounters.get(key.key) || 0;
          if (current <= 1) {
            this.concurrencyCounters.delete(key.key);
          } else {
            this.concurrencyCounters.set(key.key, current - 1);
          }
        }
      },
    };
  }

  private breakerKey(resolvedRoute: GatewayResolvedRoute) {
    return resolvedRoute.policies.traffic.circuitBreakerRef
      ? `breaker-ref:${resolvedRoute.policies.traffic.circuitBreakerRef}`
      : `route:${resolvedRoute.routeBinding.id}`;
  }

  private async emitPolicyEvent(
    resolvedRoute: GatewayResolvedRoute,
    eventName: string,
    details: Record<string, unknown>,
  ) {
    this.gatewayRuntimeMetricsService.recordPolicyEvent({
      runtimeAssetId: resolvedRoute.runtimeAsset.id,
      runtimeMembershipId: resolvedRoute.membership.id,
      routePath: resolvedRoute.routeBinding.routePath,
      routeMethod: resolvedRoute.routeBinding.routeMethod,
      policyName: eventName,
    });
    const { severity, status, ...rest } = details;
    await this.runtimeObservabilityService.recordRuntimeControlEvent({
      runtimeAssetId: resolvedRoute.runtimeAsset.id,
      runtimeMembershipId: resolvedRoute.membership.id,
      eventFamily: RuntimeObservabilityEventFamily.RUNTIME_POLICY,
      eventName,
      severity:
        (severity as RuntimeObservabilitySeverity | undefined) ||
        RuntimeObservabilitySeverity.WARNING,
      status:
        (status as RuntimeObservabilityStatus | undefined) ||
        RuntimeObservabilityStatus.FAILED,
      summary: `${resolvedRoute.routeBinding.routeMethod} ${resolvedRoute.routeBinding.routePath} ${eventName}`,
      details: rest,
      dimensions: {
        routePath: resolvedRoute.routeBinding.routePath,
        routeMethod: resolvedRoute.routeBinding.routeMethod,
      },
    });
  }
}
