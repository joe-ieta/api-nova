import { Injectable } from '@nestjs/common';
import {
  RuntimeObservabilityEventFamily,
  RuntimeObservabilitySeverity,
  RuntimeObservabilityStatus,
} from '../../../database/entities/runtime-observability-event.entity';
import { RuntimeObservabilityService } from '../../runtime-observability/services/runtime-observability.service';

type RuntimeAssetRouteMetrics = {
  runtimeMembershipId: string;
  routePath: string;
  routeMethod: string;
  requestCount: number;
  successCount: number;
  errorCount: number;
  cacheHitCount: number;
  cacheMissCount: number;
  policyCounts: Record<string, number>;
  avgLatencyMs: number;
  lastStatusCode?: number;
  lastRequestAt?: string;
  lastErrorAt?: string;
  lastErrorMessage?: string;
};

type RuntimeAssetMetricsState = {
  runtimeAssetId: string;
  requestCount: number;
  successCount: number;
  errorCount: number;
  cacheHitCount: number;
  cacheMissCount: number;
  policyCounts: Record<string, number>;
  avgLatencyMs: number;
  lastStatusCode?: number;
  lastRequestAt?: string;
  lastErrorAt?: string;
  lastErrorMessage?: string;
  routes: Map<string, RuntimeAssetRouteMetrics>;
};

@Injectable()
export class GatewayRuntimeMetricsService {
  private readonly metrics = new Map<string, RuntimeAssetMetricsState>();

  constructor(
    private readonly runtimeObservabilityService: RuntimeObservabilityService,
  ) {}

  async recordForwardResult(input: {
    runtimeAssetId: string;
    runtimeMembershipId: string;
    routePath: string;
    routeMethod: string;
    requestId?: string;
    correlationId?: string;
    latencyMs: number;
    statusCode?: number;
    success: boolean;
    errorMessage?: string;
    }) {
    const state = this.ensureState(input.runtimeAssetId);
    state.requestCount += 1;
    state.successCount += input.success ? 1 : 0;
    state.errorCount += input.success ? 0 : 1;
    state.avgLatencyMs = this.nextAverage(
      state.avgLatencyMs,
      state.requestCount,
      input.latencyMs,
    );
    state.lastStatusCode = input.statusCode;
    state.lastRequestAt = new Date().toISOString();
    if (!input.success) {
      state.lastErrorAt = state.lastRequestAt;
      state.lastErrorMessage = input.errorMessage;
    }

    const routeKey = `${input.runtimeMembershipId}:${input.routeMethod}:${input.routePath}`;
    const routeState =
      state.routes.get(routeKey) ||
      ({
        runtimeMembershipId: input.runtimeMembershipId,
        routePath: input.routePath,
        routeMethod: input.routeMethod,
        requestCount: 0,
        successCount: 0,
        errorCount: 0,
        cacheHitCount: 0,
        cacheMissCount: 0,
        policyCounts: {},
        avgLatencyMs: 0,
      } as RuntimeAssetRouteMetrics);

    routeState.requestCount += 1;
    routeState.successCount += input.success ? 1 : 0;
    routeState.errorCount += input.success ? 0 : 1;
    routeState.avgLatencyMs = this.nextAverage(
      routeState.avgLatencyMs,
      routeState.requestCount,
      input.latencyMs,
    );
    routeState.lastStatusCode = input.statusCode;
    routeState.lastRequestAt = state.lastRequestAt;
    if (!input.success) {
      routeState.lastErrorAt = state.lastRequestAt;
      routeState.lastErrorMessage = input.errorMessage;
    }

    state.routes.set(routeKey, routeState);

    await this.runtimeObservabilityService.recordGatewayRequestResult(input);
  }

  getRuntimeAssetMetrics(runtimeAssetId: string) {
    const state = this.metrics.get(runtimeAssetId);
    if (!state) {
      return {
        runtimeAssetId,
        requestCount: 0,
        successCount: 0,
        errorCount: 0,
        cacheHitCount: 0,
        cacheMissCount: 0,
        policyCounts: {},
        successRate: 0,
        avgLatencyMs: 0,
        lastStatusCode: undefined,
        lastRequestAt: undefined,
        lastErrorAt: undefined,
        lastErrorMessage: undefined,
        routes: [],
      };
    }

    return {
      runtimeAssetId: state.runtimeAssetId,
      requestCount: state.requestCount,
      successCount: state.successCount,
      errorCount: state.errorCount,
      cacheHitCount: state.cacheHitCount,
      cacheMissCount: state.cacheMissCount,
      policyCounts: { ...state.policyCounts },
      successRate:
        state.requestCount > 0 ? state.successCount / state.requestCount : 0,
      avgLatencyMs: Math.round(state.avgLatencyMs * 100) / 100,
      lastStatusCode: state.lastStatusCode,
      lastRequestAt: state.lastRequestAt,
      lastErrorAt: state.lastErrorAt,
      lastErrorMessage: state.lastErrorMessage,
      routes: Array.from(state.routes.values()).map(route => ({
        ...route,
        successRate:
          route.requestCount > 0 ? route.successCount / route.requestCount : 0,
        avgLatencyMs: Math.round(route.avgLatencyMs * 100) / 100,
      })),
    };
  }

  private ensureState(runtimeAssetId: string) {
    let state = this.metrics.get(runtimeAssetId);
    if (!state) {
      state = {
        runtimeAssetId,
        requestCount: 0,
        successCount: 0,
        errorCount: 0,
        cacheHitCount: 0,
        cacheMissCount: 0,
        policyCounts: {},
        avgLatencyMs: 0,
        routes: new Map<string, RuntimeAssetRouteMetrics>(),
      };
      this.metrics.set(runtimeAssetId, state);
    }
    return state;
  }

  private nextAverage(previousAverage: number, nextCount: number, nextValue: number) {
    if (nextCount <= 1) {
      return nextValue;
    }
    return previousAverage + (nextValue - previousAverage) / nextCount;
  }

  async recordCacheResult(input: {
    runtimeAssetId: string;
    runtimeMembershipId: string;
    routePath: string;
    routeMethod: string;
    cacheStatus: 'hit' | 'miss';
    requestId?: string;
    correlationId?: string;
  }) {
    const state = this.ensureState(input.runtimeAssetId);
    if (input.cacheStatus === 'hit') {
      state.cacheHitCount += 1;
    } else {
      state.cacheMissCount += 1;
    }

    const routeKey = `${input.runtimeMembershipId}:${input.routeMethod}:${input.routePath}`;
    const routeState =
      state.routes.get(routeKey) ||
      ({
        runtimeMembershipId: input.runtimeMembershipId,
        routePath: input.routePath,
        routeMethod: input.routeMethod,
        requestCount: 0,
        successCount: 0,
        errorCount: 0,
        cacheHitCount: 0,
        cacheMissCount: 0,
        avgLatencyMs: 0,
      } as RuntimeAssetRouteMetrics);

    if (input.cacheStatus === 'hit') {
      routeState.cacheHitCount += 1;
    } else {
      routeState.cacheMissCount += 1;
    }
    state.routes.set(routeKey, routeState);

    await this.runtimeObservabilityService.recordGatewayCacheResult(input);
  }

  recordPolicyEvent(input: {
    runtimeAssetId: string;
    runtimeMembershipId: string;
    routePath: string;
    routeMethod: string;
    policyName: string;
  }) {
    const state = this.ensureState(input.runtimeAssetId);
    state.policyCounts[input.policyName] = Number(state.policyCounts[input.policyName] || 0) + 1;

    const routeKey = `${input.runtimeMembershipId}:${input.routeMethod}:${input.routePath}`;
    const routeState =
      state.routes.get(routeKey) ||
      ({
        runtimeMembershipId: input.runtimeMembershipId,
        routePath: input.routePath,
        routeMethod: input.routeMethod,
        requestCount: 0,
        successCount: 0,
        errorCount: 0,
        cacheHitCount: 0,
        cacheMissCount: 0,
        policyCounts: {},
        avgLatencyMs: 0,
      } as RuntimeAssetRouteMetrics);

    routeState.policyCounts[input.policyName] =
      Number(routeState.policyCounts[input.policyName] || 0) + 1;
    state.routes.set(routeKey, routeState);
  }

  async recordRouteMiss(input: {
    method: string;
    routePath: string;
    host?: string;
    requestId?: string;
    correlationId?: string;
    clientIp?: string;
  }) {
    try {
      await this.runtimeObservabilityService.recordGatewayRouteMiss(input);
    } catch {
      // Route-miss observability must not alter the 404 response path.
    }
  }

  async recordPolicyObservabilityEvent(input: {
    runtimeAssetId: string;
    runtimeMembershipId: string;
    routePath: string;
    routeMethod: string;
    policyName: string;
    requestId?: string;
    correlationId?: string;
    clientIp?: string;
    status?: RuntimeObservabilityStatus;
    severity?: RuntimeObservabilitySeverity;
    errorMessage?: string;
  }) {
    try {
      await this.runtimeObservabilityService.recordRuntimeControlEvent({
        runtimeAssetId: input.runtimeAssetId,
        runtimeMembershipId: input.runtimeMembershipId,
        eventFamily: RuntimeObservabilityEventFamily.RUNTIME_POLICY,
        eventName: input.policyName,
        status: input.status || RuntimeObservabilityStatus.FAILED,
        severity: input.severity || RuntimeObservabilitySeverity.WARNING,
        summary: `${input.routeMethod} ${input.routePath} ${input.policyName}`,
        details: {
          requestId: input.requestId,
          correlationId: input.correlationId,
          clientIp: input.clientIp,
          errorMessage: input.errorMessage,
        },
        dimensions: {
          routePath: input.routePath,
          routeMethod: input.routeMethod,
        },
      });
    } catch {
      // Policy observability is best-effort and must not block request completion.
    }
  }
}
