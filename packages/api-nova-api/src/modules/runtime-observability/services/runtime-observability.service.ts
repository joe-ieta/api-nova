import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, MoreThanOrEqual, Repository } from 'typeorm';
import { createHash, randomUUID } from 'crypto';
import { isCurrentSqljsWriteOwner } from '../../../database/sqljs-persistence';
import { createRuntimeWriteScheduler, RuntimeWriteJob } from './runtime-observability-write-lane';
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

export interface GatewayRequestResultInput {
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
}
const enqueueRuntimeWrite = createRuntimeWriteScheduler<RuntimeObservabilityService, GatewayRequestResultInput>();
type RuntimeJob = RuntimeWriteJob<RuntimeObservabilityService, GatewayRequestResultInput>;
interface RuntimeWriteBatch {
  metricQueries: Map<string, RuntimeMetricSeriesEntity | null>;
  metrics: Map<string, RuntimeMetricSeriesEntity>;
  stateQueries: Map<string, RuntimeObservabilityStateEntity | null>;
  states: Map<string, RuntimeObservabilityStateEntity>;
  refs: Map<string, ResolvedRuntimeRefs>;
  events: RuntimeObservabilityEventEntity[];
}

type ResolvedRuntimeRefs = {
  runtimeAssetId: string;
  runtimeAssetEndpointBindingId?: string;
  endpointDefinitionId?: string;
  sourceServiceAssetId?: string;
};

@Injectable()
export class RuntimeObservabilityService {
  private readonly logger = new Logger(RuntimeObservabilityService.name);
  private writeManager?: EntityManager;
  private writeBatch?: RuntimeWriteBatch;

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

  async recordGatewayRequestResult(input: GatewayRequestResultInput): Promise<void> {
    if (!this.writeManager) return this.withRuntimeWrite(input.runtimeAssetId,
      scoped => scoped.recordGatewayRequestResult(input), input);
    const refs = await this.resolveRuntimeRefs(
      input.runtimeAssetId,
      input.runtimeMembershipId,
    );
    const now = new Date();
    const minuteWindow = this.toMinuteWindow(now);

    await this.persistSequentially([
      () => this.incrementMetricCounter(
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
      () => this.incrementMetricCounter(
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
      () => this.updateMetricAverage(
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
      () => this.incrementMetricCounter(
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
      () => this.updateMetricAverage(
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

    await this.persistSequentially([
      () => this.upsertState({
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
      () => this.upsertState({
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
          requestId: input.requestId,
          correlationId: input.correlationId,
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
  }): Promise<void> {
    if (!this.writeManager) return this.withRuntimeWrite(input.runtimeAssetId,
      scoped => scoped.recordRuntimeControlEvent(input));
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
      countersDelta:
        input.eventFamily === RuntimeObservabilityEventFamily.RUNTIME_POLICY
          ? { [input.eventName]: 1 }
          : undefined,
      dimensionsPatch: input.dimensions,
    });
  }

  async recordGatewayRouteMiss(input: {
    method: string;
    routePath: string;
    host?: string;
    requestId?: string;
    correlationId?: string;
    clientIp?: string;
  }) {
    await this.writeEvent({
      eventFamily: RuntimeObservabilityEventFamily.RUNTIME_ROUTE,
      eventName: 'gateway.route_not_found',
      severity: RuntimeObservabilitySeverity.WARNING,
      status: RuntimeObservabilityStatus.FAILED,
      summary: `${input.method} ${input.routePath} did not match any active gateway route`,
      details: {
        host: input.host,
        requestId: input.requestId,
        correlationId: input.correlationId,
        clientIp: input.clientIp,
      },
      dimensions: {
        host: input.host,
        routePath: input.routePath,
        routeMethod: input.method,
      },
      retentionClass: RuntimeObservabilityRetentionClass.STANDARD,
    });
  }

  async recordGatewayCacheResult(input: {
    runtimeAssetId: string;
    runtimeMembershipId: string;
    routePath: string;
    routeMethod: string;
    cacheStatus: 'hit' | 'miss';
    requestId?: string;
    correlationId?: string;
  }): Promise<void> {
    if (!this.writeManager) return this.withRuntimeWrite(input.runtimeAssetId,
      scoped => scoped.recordGatewayCacheResult(input));
    const refs = await this.resolveRuntimeRefs(
      input.runtimeAssetId,
      input.runtimeMembershipId,
    );
    const now = new Date();
    const minuteWindow = this.toMinuteWindow(now);
    const metricName =
      input.cacheStatus === 'hit' ? 'gateway.cache.hit' : 'gateway.cache.miss';

    await this.persistSequentially([
      () => this.incrementMetricCounter(
        refs,
        RuntimeMetricScope.RUNTIME_ASSET,
        metricName,
        minuteWindow,
        1,
        {
          routePath: input.routePath,
          routeMethod: input.routeMethod,
        },
      ),
      () => this.incrementMetricCounter(
        refs,
        RuntimeMetricScope.RUNTIME_MEMBERSHIP,
        metricName,
        minuteWindow,
        1,
        {
          routePath: input.routePath,
          routeMethod: input.routeMethod,
        },
      ),
      () => this.upsertState({
        refs,
        scopeType: RuntimeObservabilityScopeType.RUNTIME_ASSET,
        lastEventAt: now,
        countersDelta: {
          [metricName]: 1,
        },
        dimensionsPatch: {
          lastRoutePath: input.routePath,
          lastRouteMethod: input.routeMethod,
          lastCacheStatus: input.cacheStatus,
        },
      }),
    ]);

    await this.writeEvent({
      ...refs,
      eventFamily: RuntimeObservabilityEventFamily.RUNTIME_REQUEST,
      eventName: `gateway.cache_${input.cacheStatus}`,
      severity: RuntimeObservabilitySeverity.INFO,
      status: RuntimeObservabilityStatus.SUCCESS,
      summary: `${input.routeMethod} ${input.routePath} cache ${input.cacheStatus}`,
      details: {
        requestId: input.requestId,
        correlationId: input.correlationId,
        cacheStatus: input.cacheStatus,
      },
      dimensions: {
        routePath: input.routePath,
        routeMethod: input.routeMethod,
        cacheStatus: input.cacheStatus,
      },
      retentionClass: RuntimeObservabilityRetentionClass.STANDARD,
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

  /** Adjacent root request results share one durable transaction and SQL flush.
   * Bound managers and cache/control barriers keep their immediate semantics. */
  private async withRuntimeWrite(runtimeAssetId: string,
    operation: (scoped: RuntimeObservabilityService) => Promise<void>, request?: GatewayRequestResultInput): Promise<void> {
    const originalManager = this.eventRepository.manager;
    const job: RuntimeJob = { kind: request ? 'request' : 'barrier', operation, request };
    // Bound managers and root-manager calls reentering the current SQL.js owner
    // must not join outsiders or wait behind callers blocked by that owner.
    // Checking global isTransactionActive alone would incorrectly admit outsiders.
    if (originalManager.queryRunner || isCurrentSqljsWriteOwner(originalManager.connection)) {
      return this.executeRuntimeWriteBatch(runtimeAssetId, [job], false);
    }
    return enqueueRuntimeWrite(originalManager.connection, runtimeAssetId, job,
      jobs => this.executeRuntimeWriteBatch(runtimeAssetId, jobs, jobs[0].kind === 'request'));
  }

  private executeRuntimeWriteBatch(runtimeAssetId: string, jobs: readonly RuntimeJob[], batch: boolean): Promise<void> {
    return this.eventRepository.manager.transaction(async manager => {
      if (manager.connection.options.type === 'postgres') {
        const key = createHash('sha256').update('api-nova.runtime-observability.v1:')
          .update(runtimeAssetId).digest();
        await manager.query('SELECT pg_advisory_xact_lock($1, $2)', [key.readInt32BE(0), key.readInt32BE(4)]);
      }
      const scoped = new RuntimeObservabilityService(
        manager.getRepository(RuntimeAssetEntity), manager.getRepository(RuntimeAssetEndpointBindingEntity),
        manager.getRepository(EndpointDefinitionEntity), manager.getRepository(RuntimeObservabilityEventEntity),
        manager.getRepository(RuntimeMetricSeriesEntity), manager.getRepository(RuntimeObservabilityStateEntity),
      );
      scoped.writeManager = manager;
      if (batch) {
        scoped.writeBatch = { metricQueries: new Map(), metrics: new Map(), stateQueries: new Map(),
          states: new Map(), refs: new Map(), events: [] };
        await scoped.prefetchRuntimeRefs(jobs.map(job => job.request!));
      }
      for (const job of jobs) await job.operation(scoped);
      if (batch) await scoped.flushRuntimeWriteBatch();
    });
  }

  private async prefetchRuntimeRefs(inputs: readonly GatewayRequestResultInput[]): Promise<void> {
    const ids = [...new Set(inputs.map(input => input.runtimeMembershipId).filter(Boolean))];
    const bindings = ids.length ? await this.runtimeBindingRepository.findBy({ id: In(ids) }) : [];
    const endpoints = [...new Set(bindings.map(binding => binding.endpointDefinitionId).filter(Boolean))];
    const definitions = endpoints.length ? await this.endpointDefinitionRepository.findBy({ id: In(endpoints) }) : [];
    const byBinding = new Map(bindings.map(row => [row.id, row]));
    const byEndpoint = new Map(definitions.map(row => [row.id, row]));
    for (const input of inputs) {
      const refs: ResolvedRuntimeRefs = { runtimeAssetId: input.runtimeAssetId,
        runtimeAssetEndpointBindingId: input.runtimeMembershipId };
      const binding = byBinding.get(input.runtimeMembershipId);
      if (binding) {
        refs.endpointDefinitionId = binding.endpointDefinitionId;
        refs.sourceServiceAssetId = byEndpoint.get(binding.endpointDefinitionId)?.sourceServiceAssetId;
      } else if (input.runtimeMembershipId) {
        this.logger.warn(`Runtime observability membership '${input.runtimeMembershipId}' not found`);
      }
      this.writeBatch!.refs.set(JSON.stringify([input.runtimeAssetId, input.runtimeMembershipId || null]), refs);
    }
  }

  private async flushRuntimeWriteBatch(): Promise<void> {
    const batch = this.writeBatch!;
    // No natural-key migration: update the actual row IDs selected by legacy
    // findOne semantics, including aliases produced by NULL/undefined predicates.
    const save = async (repository: Repository<any>, rows: any[]) => {
      for (let offset = 0; offset < rows.length; offset += 16) await repository.upsert(rows.slice(offset, offset + 16), ['id']);
    };
    await save(this.metricSeriesRepository, [...batch.metrics.values()]);
    // SQLite upsert does not synthesize @UpdateDateColumn conflict updates.
    // Explicit SQL time preserves save's database-clock behavior on both dialects;
    // retaining loaded createdAt preserves the original row age.
    await save(this.stateRepository, [...batch.states.values()].map(state => ({
      ...state, updatedAt: () => 'CURRENT_TIMESTAMP',
    })));
    for (let offset = 0; offset < batch.events.length; offset += 16) {
      await this.eventRepository.insert(batch.events.slice(offset, offset + 16));
    }
  }

  /** Match TypeORM's existing ignored null/undefined where fields. Exact database
   * selection is retained on first lookup; only missing rows consult staged creates. */
  private batchLookupKey(where: Record<string, unknown>): string {
    return JSON.stringify(Object.entries(where).filter(([, value]) => value !== null && value !== undefined));
  }

  private matchesBatchWhere(row: any, where: Record<string, unknown>): boolean {
    return Object.entries(where).every(([key, value]) => value === null || value === undefined ||
      (value instanceof Date ? row[key]?.getTime() === value.getTime() : row[key] === value));
  }

  private async findBatchRow<T extends { id: string }>(repository: Repository<any>, where: Record<string, unknown>,
    queries: Map<string, T | null>, rows: Map<string, T>): Promise<T | null> {
    const key = this.batchLookupKey(where);
    if (queries.has(key)) return queries.get(key)!;
    let found = await repository.findOne({ where }) as T | null;
    if (found) found = rows.get(found.id) || found;
    else found = [...rows.values()].find(row => this.matchesBatchWhere(row, where)) || null;
    queries.set(key, found);
    return found;
  }

  private async saveMetric(metric: RuntimeMetricSeriesEntity): Promise<RuntimeMetricSeriesEntity> {
    if (!this.writeBatch) return this.metricSeriesRepository.save(metric);
    if (!metric.id) metric.id = randomUUID();
    this.writeBatch.metrics.set(metric.id, metric);
    // Previously absent query aliases must discover this newly staged row.
    for (const [key, value] of this.writeBatch.metricQueries) if (!value) this.writeBatch.metricQueries.delete(key);
    return metric;
  }

  private async persistSequentially(operations: Array<() => Promise<unknown>>): Promise<void> {
    // Do not let Promise.all reject while sibling statements are still running
    // against a transaction that the caller is about to roll back.
    for (const operation of operations) await operation();
  }

  private async resolveRuntimeRefs(
    runtimeAssetId: string,
    runtimeMembershipId?: string,
  ): Promise<ResolvedRuntimeRefs> {
    const cached = this.writeBatch?.refs.get(JSON.stringify([runtimeAssetId, runtimeMembershipId || null]));
    if (cached) return cached;
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
    runtimeAssetId?: string;
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
    if (this.writeBatch) {
      entity.id = randomUUID(); this.writeBatch.events.push(entity); return entity;
    }
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
      return this.saveMetric(metric);
    }

    return this.saveMetric(
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
      return this.saveMetric(metric);
    }

    return this.saveMetric(
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
    const where = {
        runtimeAssetId: refs.runtimeAssetId,
        runtimeAssetEndpointBindingId: refs.runtimeAssetEndpointBindingId,
        metricScope: scope,
        metricName,
        aggregationWindow: RuntimeMetricAggregationWindow.MINUTE,
        windowStartedAt: window.startedAt,
        windowEndedAt: window.endedAt,
    };
    if (this.writeBatch) return this.findBatchRow(this.metricSeriesRepository, where,
      this.writeBatch.metricQueries, this.writeBatch.metrics);
    return this.metricSeriesRepository.findOne({ where });
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

    let state = this.writeBatch ? await this.findBatchRow(this.stateRepository, where,
      this.writeBatch.stateQueries, this.writeBatch.states) : await this.stateRepository.findOne({ where });
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

    if (this.writeBatch) {
      if (!state.id) state.id = randomUUID();
      this.writeBatch.states.set(state.id, state);
      for (const [key, value] of this.writeBatch.stateQueries) if (!value) this.writeBatch.stateQueries.delete(key);
      return state;
    }
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
