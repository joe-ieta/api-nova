import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, MoreThanOrEqual, Repository } from 'typeorm';
import { EndpointDefinitionEntity } from '../../../database/entities/endpoint-definition.entity';
import {
  RuntimeMetricAggregationWindow,
  RuntimeMetricScope,
  RuntimeMetricSeriesEntity,
  RuntimeMetricType,
} from '../../../database/entities/runtime-metric-series.entity';
import {
  RuntimeObservabilityActorType,
  RuntimeObservabilityEventEntity,
  RuntimeObservabilityEventFamily,
  RuntimeObservabilityRetentionClass,
  RuntimeObservabilitySeverity,
  RuntimeObservabilityStatus,
} from '../../../database/entities/runtime-observability-event.entity';
import {
  RuntimeCurrentStatus,
  RuntimeHealthStatus,
  RuntimeObservabilityScopeType,
  RuntimeObservabilityStateEntity,
} from '../../../database/entities/runtime-observability-state.entity';
import { RuntimeAssetEndpointBindingEntity } from '../../../database/entities/runtime-asset-endpoint-binding.entity';
import { RuntimeAssetEntity } from '../../../database/entities/runtime-asset.entity';

type ResolvedRuntimeRefs = {
  runtimeAssetId: string;
  runtimeAssetEndpointBindingId?: string;
  endpointDefinitionId?: string;
  sourceServiceAssetId?: string;
};

@Injectable()
export class RuntimeObservabilityService {
  private readonly logger = new Logger(RuntimeObservabilityService.name);

  constructor(
    @InjectRepository(RuntimeAssetEntity)
    private readonly runtimeAssetRepository: Repository<RuntimeAssetEntity>,
    @InjectRepository(RuntimeAssetEndpointBindingEntity)
    private readonly runtimeBindingRepository: Repository<RuntimeAssetEndpointBindingEntity>,
    @InjectRepository(EndpointDefinitionEntity)
    private readonly endpointDefinitionRepository: Repository<EndpointDefinitionEntity>,
    @InjectRepository(RuntimeObservabilityEventEntity)
    private readonly eventRepository: Repository<RuntimeObservabilityEventEntity>,
    @InjectRepository(RuntimeMetricSeriesEntity)
    private readonly metricSeriesRepository: Repository<RuntimeMetricSeriesEntity>,
    @InjectRepository(RuntimeObservabilityStateEntity)
    private readonly stateRepository: Repository<RuntimeObservabilityStateEntity>,
  ) {}

  async recordGatewayRequestResult(input: {
    runtimeAssetId: string;
    runtimeMembershipId: string;
    routePath: string;
    routeMethod: string;
    latencyMs: number;
    statusCode?: number;
    success: boolean;
    errorMessage?: string;
  }) {
    const refs = await this.resolveRuntimeRefs(
      input.runtimeAssetId,
      input.runtimeMembershipId,
    );
    const now = new Date();
    const minuteWindow = this.toMinuteWindow(now);

    await Promise.all([
      this.incrementMetricCounter(
        refs,
        RuntimeMetricScope.RUNTIME_ASSET,
        'gateway.requests.total',
        minuteWindow,
        1,
        {
          routePath: input.routePath,
          routeMethod: input.routeMethod,
        },
      ),
      this.incrementMetricCounter(
        refs,
        RuntimeMetricScope.RUNTIME_ASSET,
        input.success ? 'gateway.requests.success' : 'gateway.requests.error',
        minuteWindow,
        1,
        {
          routePath: input.routePath,
          routeMethod: input.routeMethod,
          statusCode: input.statusCode,
        },
      ),
      this.updateMetricAverage(
        refs,
        RuntimeMetricScope.RUNTIME_ASSET,
        'gateway.latency.avg_ms',
        minuteWindow,
        input.latencyMs,
        {
          routePath: input.routePath,
          routeMethod: input.routeMethod,
        },
      ),
      this.incrementMetricCounter(
        refs,
        RuntimeMetricScope.RUNTIME_MEMBERSHIP,
        'gateway.requests.total',
        minuteWindow,
        1,
        {
          routePath: input.routePath,
          routeMethod: input.routeMethod,
        },
      ),
      this.updateMetricAverage(
        refs,
        RuntimeMetricScope.RUNTIME_MEMBERSHIP,
        'gateway.latency.avg_ms',
        minuteWindow,
        input.latencyMs,
        {
          routePath: input.routePath,
          routeMethod: input.routeMethod,
        },
      ),
    ]);

    await Promise.all([
      this.upsertState({
        refs,
        scopeType: RuntimeObservabilityScopeType.RUNTIME_ASSET,
        currentStatus: input.success
          ? RuntimeCurrentStatus.ACTIVE
          : RuntimeCurrentStatus.DEGRADED,
        healthStatus: input.success
          ? RuntimeHealthStatus.HEALTHY
          : RuntimeHealthStatus.DEGRADED,
        summary: `${input.routeMethod} ${input.routePath}`,
        lastEventAt: now,
        lastSuccessAt: input.success ? now : undefined,
        lastFailureAt: input.success ? undefined : now,
        lastErrorMessage: input.success ? undefined : input.errorMessage,
        countersDelta: {
          requestCount: 1,
          successCount: input.success ? 1 : 0,
          errorCount: input.success ? 0 : 1,
        },
        gaugesPatch: {
          lastLatencyMs: input.latencyMs,
          lastStatusCode: input.statusCode ?? null,
        },
        dimensionsPatch: {
          lastRoutePath: input.routePath,
          lastRouteMethod: input.routeMethod,
        },
      }),
      this.upsertState({
        refs,
        scopeType: RuntimeObservabilityScopeType.RUNTIME_MEMBERSHIP,
        currentStatus: input.success
          ? RuntimeCurrentStatus.ACTIVE
          : RuntimeCurrentStatus.DEGRADED,
        healthStatus: input.success
          ? RuntimeHealthStatus.HEALTHY
          : RuntimeHealthStatus.DEGRADED,
        summary: `${input.routeMethod} ${input.routePath}`,
        lastEventAt: now,
        lastSuccessAt: input.success ? now : undefined,
        lastFailureAt: input.success ? undefined : now,
        lastErrorMessage: input.success ? undefined : input.errorMessage,
        countersDelta: {
          requestCount: 1,
          successCount: input.success ? 1 : 0,
          errorCount: input.success ? 0 : 1,
        },
        gaugesPatch: {
          lastLatencyMs: input.latencyMs,
          lastStatusCode: input.statusCode ?? null,
        },
        dimensionsPatch: {
          routePath: input.routePath,
          routeMethod: input.routeMethod,
        },
      }),
    ]);

    if (!input.success) {
      await this.writeEvent({
        ...refs,
        eventFamily: RuntimeObservabilityEventFamily.RUNTIME_ERROR,
        eventName: 'gateway.request_failed',
        severity: RuntimeObservabilitySeverity.ERROR,
        status: RuntimeObservabilityStatus.FAILED,
        summary: `${input.routeMethod} ${input.routePath} failed`,
        details: {
          statusCode: input.statusCode,
          latencyMs: input.latencyMs,
          errorMessage: input.errorMessage,
        },
        dimensions: {
          routePath: input.routePath,
          routeMethod: input.routeMethod,
        },
        retentionClass: RuntimeObservabilityRetentionClass.STANDARD,
      });
    }
  }

  async recordRuntimeControlEvent(input: {
    runtimeAssetId: string;
    runtimeMembershipId?: string;
    eventFamily: RuntimeObservabilityEventFamily;
    eventName: string;
    status: RuntimeObservabilityStatus;
    severity?: RuntimeObservabilitySeverity;
    currentStatus?: RuntimeCurrentStatus;
    healthStatus?: RuntimeHealthStatus;
    summary?: string;
    details?: Record<string, unknown>;
    dimensions?: Record<string, unknown>;
  }) {
    const refs = await this.resolveRuntimeRefs(
      input.runtimeAssetId,
      input.runtimeMembershipId,
    );
    const now = new Date();

    await this.writeEvent({
      ...refs,
      eventFamily: input.eventFamily,
      eventName: input.eventName,
      severity: input.severity || RuntimeObservabilitySeverity.INFO,
      status: input.status,
      summary: input.summary,
      details: input.details,
      dimensions: input.dimensions,
      retentionClass: RuntimeObservabilityRetentionClass.STANDARD,
    });

    await this.upsertState({
      refs,
      scopeType: RuntimeObservabilityScopeType.RUNTIME_ASSET,
      currentStatus: input.currentStatus,
      healthStatus: input.healthStatus,
      summary: input.summary,
      lastEventAt: now,
      lastSuccessAt:
        input.status === RuntimeObservabilityStatus.SUCCESS ||
        input.status === RuntimeObservabilityStatus.ACTIVE
          ? now
          : undefined,
      lastFailureAt: input.status === RuntimeObservabilityStatus.FAILED ? now : undefined,
      lastErrorMessage:
        input.status === RuntimeObservabilityStatus.FAILED
          ? String(input.details?.errorMessage || input.summary || '')
          : undefined,
      dimensionsPatch: input.dimensions,
    });
  }

  async getRuntimeAssetObservability(runtimeAssetId: string) {
    const runtimeAsset = await this.runtimeAssetRepository.findOne({
      where: { id: runtimeAssetId },
    });
    if (!runtimeAsset) {
      return null;
    }

    const [state, recentEvents, recentMetrics] = await Promise.all([
      this.stateRepository.findOne({
        where: {
          scopeType: RuntimeObservabilityScopeType.RUNTIME_ASSET,
          runtimeAssetId,
        },
      }),
      this.eventRepository.find({
        where: { runtimeAssetId },
        order: { occurredAt: 'DESC', createdAt: 'DESC' },
        take: 20,
      }),
      this.metricSeriesRepository.find({
        where: {
          runtimeAssetId,
          windowStartedAt: MoreThanOrEqual(this.hoursAgo(24)),
        },
        order: { windowStartedAt: 'DESC', createdAt: 'DESC' },
        take: 200,
      }),
    ]);

    return {
      state,
      recentEvents,
      recentMetrics,
    };
  }

  async getManagementOverview(input: { days?: number; limit?: number } = {}) {
    const days = input.days ?? 7;
    const limit = input.limit ?? 20;
    const startDate = this.daysAgo(days);

    const [
      states,
      recentEvents,
      totalRuntimeAssets,
      totalAuditLogs,
      successAuditLogs,
      failedAuditLogs,
      warningAuditLogs,
      errorAuditLogs,
    ] = await Promise.all([
      this.stateRepository.find({
        where: { scopeType: RuntimeObservabilityScopeType.RUNTIME_ASSET },
      }),
      this.eventRepository.find({
        where: { occurredAt: MoreThanOrEqual(startDate) },
        order: { occurredAt: 'DESC', createdAt: 'DESC' },
        take: limit,
      }),
      this.runtimeAssetRepository.count(),
      this.eventRepository.count({
        where: {
          occurredAt: MoreThanOrEqual(startDate),
          eventFamily: In(this.getAuditEventFamilies()),
        },
      }),
      this.eventRepository.count({
        where: {
          occurredAt: MoreThanOrEqual(startDate),
          eventFamily: In(this.getAuditEventFamilies()),
          status: In([
            RuntimeObservabilityStatus.SUCCESS,
            RuntimeObservabilityStatus.ACTIVE,
          ]),
        },
      }),
      this.eventRepository.count({
        where: {
          occurredAt: MoreThanOrEqual(startDate),
          eventFamily: In(this.getAuditEventFamilies()),
          status: RuntimeObservabilityStatus.FAILED,
        },
      }),
      this.eventRepository.count({
        where: {
          occurredAt: MoreThanOrEqual(startDate),
          eventFamily: In(this.getAuditEventFamilies()),
          severity: RuntimeObservabilitySeverity.WARNING,
        },
      }),
      this.eventRepository.count({
        where: {
          occurredAt: MoreThanOrEqual(startDate),
          eventFamily: In(this.getAuditEventFamilies()),
          severity: In([
            RuntimeObservabilitySeverity.ERROR,
            RuntimeObservabilitySeverity.CRITICAL,
          ]),
        },
      }),
    ]);

    const stateCounts = {
      totalRuntimeAssets,
      activeRuntimeAssets: states.filter(
        item => item.currentStatus === RuntimeCurrentStatus.ACTIVE,
      ).length,
      degradedRuntimeAssets: states.filter(
        item => item.currentStatus === RuntimeCurrentStatus.DEGRADED,
      ).length,
      offlineRuntimeAssets: states.filter(
        item => item.currentStatus === RuntimeCurrentStatus.OFFLINE,
      ).length,
      healthyRuntimeAssets: states.filter(
        item => item.healthStatus === RuntimeHealthStatus.HEALTHY,
      ).length,
      unhealthyRuntimeAssets: states.filter(
        item => item.healthStatus === RuntimeHealthStatus.UNHEALTHY,
      ).length,
    };

    return {
      metrics: stateCounts,
      health: {
        status:
          stateCounts.unhealthyRuntimeAssets > 0 ||
          stateCounts.degradedRuntimeAssets > 0
            ? 'degraded'
            : 'healthy',
        ...stateCounts,
      },
      auditStats: {
        totalLogs: totalAuditLogs,
        successLogs: successAuditLogs,
        failedLogs: failedAuditLogs,
        warningLogs: warningAuditLogs,
        errorLogs: errorAuditLogs,
        successRate: totalAuditLogs > 0
          ? Number((successAuditLogs / totalAuditLogs).toFixed(4))
          : 1,
      },
      recentRuntimeEvents: recentEvents.map(event => this.toManagementEvent(event)),
      recentManagementLogs: recentEvents.map(event =>
        this.toManagementEvent(event, { capabilityView: 'system' }),
      ),
    };
  }

  async getRecentManagementEvents(limit = 50) {
    const data = await this.eventRepository.find({
      order: { occurredAt: 'DESC', createdAt: 'DESC' },
      take: limit,
    });
    return data.map(event => this.toManagementEvent(event));
  }

  async getRecentManagementErrorEvents(limit = 50) {
    const data = await this.eventRepository.find({
      where: [
        { severity: RuntimeObservabilitySeverity.ERROR },
        { severity: RuntimeObservabilitySeverity.CRITICAL },
        { status: RuntimeObservabilityStatus.FAILED },
      ],
      order: { occurredAt: 'DESC', createdAt: 'DESC' },
      take: limit,
    });
    return data.map(event => this.toManagementEvent(event));
  }

  async queryManagementEvents(input: {
    page?: number;
    limit?: number;
    severity?: string;
    runtimeAssetId?: string;
  }) {
    const page = input.page ?? 1;
    const limit = input.limit ?? 20;
    const where: Record<string, unknown> = {};
    if (input.severity) {
      where.severity = input.severity;
    }
    if (input.runtimeAssetId) {
      where.runtimeAssetId = input.runtimeAssetId;
    }

    const [data, total] = await this.eventRepository.findAndCount({
      where,
      order: { occurredAt: 'DESC', createdAt: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });

    return this.toPaginatedManagementEvents(
      data.map(event => this.toManagementEvent(event)),
      total,
      page,
      limit,
    );
  }

  async queryManagementAudit(input: {
    page?: number;
    limit?: number;
    status?: string;
    runtimeAssetId?: string;
  }) {
    const page = input.page ?? 1;
    const limit = input.limit ?? 20;
    const where: Record<string, unknown> = {
      eventFamily: In(this.getAuditEventFamilies()),
    };
    if (input.status) {
      where.status = input.status;
    }
    if (input.runtimeAssetId) {
      where.runtimeAssetId = input.runtimeAssetId;
    }

    const [data, total] = await this.eventRepository.findAndCount({
      where,
      order: { occurredAt: 'DESC', createdAt: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });

    return this.toPaginatedManagementEvents(
      data.map(event => this.toManagementEvent(event, { capabilityView: 'audit' })),
      total,
      page,
      limit,
    );
  }

  private async resolveRuntimeRefs(
    runtimeAssetId: string,
    runtimeMembershipId?: string,
  ): Promise<ResolvedRuntimeRefs> {
    const refs: ResolvedRuntimeRefs = {
      runtimeAssetId,
      runtimeAssetEndpointBindingId: runtimeMembershipId,
    };

    if (!runtimeMembershipId) {
      return refs;
    }

    const membership = await this.runtimeBindingRepository.findOne({
      where: { id: runtimeMembershipId },
    });
    if (!membership) {
      this.logger.warn(
        `Runtime observability membership '${runtimeMembershipId}' not found`,
      );
      return refs;
    }

    refs.endpointDefinitionId = membership.endpointDefinitionId;
    const endpointDefinition = await this.endpointDefinitionRepository.findOne({
      where: { id: membership.endpointDefinitionId },
    });
    refs.sourceServiceAssetId = endpointDefinition?.sourceServiceAssetId;
    return refs;
  }

  private async writeEvent(input: {
    runtimeAssetId: string;
    runtimeAssetEndpointBindingId?: string;
    endpointDefinitionId?: string;
    sourceServiceAssetId?: string;
    eventFamily: RuntimeObservabilityEventFamily;
    eventName: string;
    severity: RuntimeObservabilitySeverity;
    status: RuntimeObservabilityStatus;
    summary?: string;
    details?: Record<string, unknown>;
    dimensions?: Record<string, unknown>;
    retentionClass: RuntimeObservabilityRetentionClass;
  }) {
    const entity = this.eventRepository.create({
      ...input,
      actorType: RuntimeObservabilityActorType.RUNTIME,
      occurredAt: new Date(),
    });
    return this.eventRepository.save(entity);
  }

  private async incrementMetricCounter(
    refs: ResolvedRuntimeRefs,
    scope: RuntimeMetricScope,
    metricName: string,
    window: { startedAt: Date; endedAt: Date },
    incrementBy: number,
    dimensions?: Record<string, unknown>,
  ) {
    const metric = await this.findMetricSeries(refs, scope, metricName, window);
    if (metric) {
      metric.value += incrementBy;
      metric.sampleCount += 1;
      return this.metricSeriesRepository.save(metric);
    }

    return this.metricSeriesRepository.save(
      this.metricSeriesRepository.create({
        ...refs,
        metricScope: scope,
        metricName,
        aggregationWindow: RuntimeMetricAggregationWindow.MINUTE,
        windowStartedAt: window.startedAt,
        windowEndedAt: window.endedAt,
        metricType: RuntimeMetricType.COUNTER,
        value: incrementBy,
        unit: 'count',
        sampleCount: 1,
        dimensions,
      }),
    );
  }

  private async updateMetricAverage(
    refs: ResolvedRuntimeRefs,
    scope: RuntimeMetricScope,
    metricName: string,
    window: { startedAt: Date; endedAt: Date },
    nextValue: number,
    dimensions?: Record<string, unknown>,
  ) {
    const metric = await this.findMetricSeries(refs, scope, metricName, window);
    if (metric) {
      const nextCount = metric.sampleCount + 1;
      metric.value = metric.value + (nextValue - metric.value) / nextCount;
      metric.sampleCount = nextCount;
      return this.metricSeriesRepository.save(metric);
    }

    return this.metricSeriesRepository.save(
      this.metricSeriesRepository.create({
        ...refs,
        metricScope: scope,
        metricName,
        aggregationWindow: RuntimeMetricAggregationWindow.MINUTE,
        windowStartedAt: window.startedAt,
        windowEndedAt: window.endedAt,
        metricType: RuntimeMetricType.GAUGE,
        value: nextValue,
        unit: 'ms',
        sampleCount: 1,
        dimensions,
      }),
    );
  }

  private async findMetricSeries(
    refs: ResolvedRuntimeRefs,
    scope: RuntimeMetricScope,
    metricName: string,
    window: { startedAt: Date; endedAt: Date },
  ) {
    return this.metricSeriesRepository.findOne({
      where: {
        runtimeAssetId: refs.runtimeAssetId,
        runtimeAssetEndpointBindingId: refs.runtimeAssetEndpointBindingId,
        metricScope: scope,
        metricName,
        aggregationWindow: RuntimeMetricAggregationWindow.MINUTE,
        windowStartedAt: window.startedAt,
        windowEndedAt: window.endedAt,
      },
    });
  }

  private async upsertState(input: {
    refs: ResolvedRuntimeRefs;
    scopeType: RuntimeObservabilityScopeType;
    currentStatus?: RuntimeCurrentStatus;
    healthStatus?: RuntimeHealthStatus;
    summary?: string;
    lastEventAt?: Date;
    lastSuccessAt?: Date;
    lastFailureAt?: Date;
    lastErrorMessage?: string;
    countersDelta?: Record<string, number>;
    gaugesPatch?: Record<string, number | string | boolean | null>;
    dimensionsPatch?: Record<string, unknown>;
  }) {
    const where =
      input.scopeType === RuntimeObservabilityScopeType.RUNTIME_ASSET
        ? {
            scopeType: input.scopeType,
            runtimeAssetId: input.refs.runtimeAssetId,
            runtimeAssetEndpointBindingId: null as any,
          }
        : {
            scopeType: input.scopeType,
            runtimeAssetId: input.refs.runtimeAssetId,
            runtimeAssetEndpointBindingId: input.refs.runtimeAssetEndpointBindingId,
          };

    let state = await this.stateRepository.findOne({ where });
    if (!state) {
      state = this.stateRepository.create({
        scopeType: input.scopeType,
        runtimeAssetId: input.refs.runtimeAssetId,
        runtimeAssetEndpointBindingId: input.refs.runtimeAssetEndpointBindingId,
        endpointDefinitionId: input.refs.endpointDefinitionId,
        sourceServiceAssetId: input.refs.sourceServiceAssetId,
        currentStatus: input.currentStatus || RuntimeCurrentStatus.DRAFT,
        healthStatus: input.healthStatus || RuntimeHealthStatus.UNKNOWN,
        counters: {},
        gauges: {},
        dimensions: {},
      });
    }

    if (input.currentStatus) {
      state.currentStatus = input.currentStatus;
    }
    if (input.healthStatus) {
      state.healthStatus = input.healthStatus;
    }
    if (input.summary) {
      state.summary = input.summary;
    }
    if (input.lastEventAt) {
      state.lastEventAt = input.lastEventAt;
    }
    if (input.lastSuccessAt) {
      state.lastSuccessAt = input.lastSuccessAt;
    }
    if (input.lastFailureAt) {
      state.lastFailureAt = input.lastFailureAt;
    }
    if (input.lastErrorMessage) {
      state.lastErrorMessage = input.lastErrorMessage;
    }

    state.counters = this.mergeCounters(state.counters, input.countersDelta);
    state.gauges = {
      ...(state.gauges || {}),
      ...(input.gaugesPatch || {}),
    };
    state.dimensions = {
      ...(state.dimensions || {}),
      ...(input.dimensionsPatch || {}),
    };

    return this.stateRepository.save(state);
  }

  private mergeCounters(
    current: Record<string, number> | undefined,
    delta: Record<string, number> | undefined,
  ) {
    const next = { ...(current || {}) };
    for (const [key, value] of Object.entries(delta || {})) {
      next[key] = Number(next[key] || 0) + Number(value || 0);
    }
    return next;
  }

  private toMinuteWindow(date: Date) {
    const startedAt = new Date(date);
    startedAt.setSeconds(0, 0);
    const endedAt = new Date(startedAt);
    endedAt.setMinutes(endedAt.getMinutes() + 1);
    return { startedAt, endedAt };
  }

  private hoursAgo(hours: number) {
    const date = new Date();
    date.setHours(date.getHours() - hours);
    return date;
  }

  private daysAgo(days: number) {
    const date = new Date();
    date.setDate(date.getDate() - days);
    return date;
  }

  private getAuditEventFamilies() {
    return [
      RuntimeObservabilityEventFamily.RUNTIME_CONTROL,
      RuntimeObservabilityEventFamily.RUNTIME_POLICY,
      RuntimeObservabilityEventFamily.RUNTIME_PUBLICATION,
    ];
  }

  private toManagementEvent(
    event: RuntimeObservabilityEventEntity,
    options: { capabilityView?: 'system' | 'audit' } = {},
  ) {
    const capabilityView =
      options.capabilityView ||
      (this.getAuditEventFamilies().includes(event.eventFamily) ? 'audit' : 'system');

    return {
      id: event.id,
      runtimeAssetId: event.runtimeAssetId,
      runtimeAssetEndpointBindingId: event.runtimeAssetEndpointBindingId,
      endpointDefinitionId: event.endpointDefinitionId,
      sourceServiceAssetId: event.sourceServiceAssetId,
      occurredAt: event.occurredAt,
      createdAt: event.createdAt,
      eventFamily: event.eventFamily,
      eventName: event.eventName,
      eventType: event.eventName,
      severity: event.severity,
      level: event.severity,
      status: event.status,
      summary: event.summary,
      description: event.summary,
      details: event.details || null,
      dimensions: event.dimensions || null,
      capability: capabilityView,
      action: capabilityView === 'audit' ? event.eventName : undefined,
      resource: capabilityView === 'audit' ? 'runtime_asset' : undefined,
      resourceId: capabilityView === 'audit' ? event.runtimeAssetId : undefined,
    };
  }

  private toPaginatedManagementEvents(
    data: any[],
    total: number,
    page: number,
    limit: number,
  ) {
    const totalPages = Math.max(1, Math.ceil(total / limit));
    return {
      data,
      total,
      page,
      limit,
      totalPages,
      hasNext: page < totalPages,
      hasPrev: page > 1,
    };
  }
}
