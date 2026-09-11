import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { CanonicalInvocation, redactAuditValue } from 'api-nova-parser';
import { RuntimeInvocationRevisionEntity, RuntimeAccessSourceEntity } from '../../database/entities/runtime-call-observability.entity';
import { ObservabilityAuthorization, intersectObservabilityAssets } from './call-observability-access';
import { ObservabilityApiError, observabilitySuccess } from './call-observability-api.contract';
import { ObservabilityFilter, parseObservabilityQuery } from './call-observability-query';
import { sequenceKey } from './call-observability-storage';
import { CallObservabilityStore } from './call-observability.store';
import { calculateObservabilityMetrics, MAX_METRIC_OBSERVATIONS } from './call-observability-metrics';
import { ObservabilityStatisticsSummaryDto, ObservabilityStatisticsTimeSeriesDto,
  ObservabilityStatisticsBucketDto, ObservabilityStatisticsGroupsDto } from './call-observability-statistics.dto';

export const STATISTICS_SCOPES = ['business', 'http_ingress', 'tool', 'protocol', 'upstream'] as const;
export const STATISTICS_SUMMARY_QUERY_KEYS = ['from', 'to', 'timeBasis', 'origin', 'scope', 'serverType',
  'runtimeAssetId', 'callerId', 'sourceId', 'endpointDefinitionId', 'toolName', 'sourceServiceInstanceId',
  'spanKind', 'outcome', 'traceId', 'requestId', 'errorCategory'] as const;
export const STATISTICS_TIME_SERIES_QUERY_KEYS = [...STATISTICS_SUMMARY_QUERY_KEYS, 'interval', 'fill'] as const;
export const STATISTICS_GROUPS_QUERY_KEYS = [...STATISTICS_SUMMARY_QUERY_KEYS, 'groupBy', 'orderBy', 'top'] as const;
export const STATISTICS_INTERVALS = { '1m': 60000, '5m': 300000, '1h': 3600000, '1d': 86400000 } as const;
export const MAX_STATISTICS_BUCKETS = 1440;
export const MAX_STATISTICS_GROUP_LIMIT = 100;
export const STATISTICS_GROUP_DIMENSIONS = ['runtimeAssetId', 'serverType', 'callerId', 'endpointDefinitionId',
  'toolName', 'sourceServiceInstanceId', 'outcome'] as const;
export const STATISTICS_GROUP_ORDER_BY = ['selectedInvocations', 'failures', 'successes', 'uniqueCallers', 'upstreamRequests'] as const;
export const STATISTICS_GROUP_COMBINATIONS: string[][] = STATISTICS_GROUP_DIMENSIONS.flatMap((dimension, index) =>
  [[dimension], ...STATISTICS_GROUP_DIMENSIONS.slice(index + 1).map(other => [dimension, other])]);
const COLUMNS = ['serverType', 'callerId', 'sourceId', 'endpointDefinitionId', 'toolName',
  'sourceServiceInstanceId', 'spanKind', 'outcome', 'traceId'] as const;
type Row = RuntimeInvocationRevisionEntity & { metricSource?: Pick<RuntimeAccessSourceEntity, 'sourceId' | 'ipSource'> };
type StatisticsMode = 'summary' | 'time-series' | 'groups';

@Injectable()
export class CallObservabilityStatisticsService {
  constructor(private readonly store: CallObservabilityStore) {}

  async summary(raw: Record<string, unknown>, authorization: ObservabilityAuthorization) {
    return this.read(raw, STATISTICS_SUMMARY_QUERY_KEYS, authorization, 'summary');
  }

  async timeSeries(raw: Record<string, unknown>, authorization: ObservabilityAuthorization) {
    return this.read(raw, STATISTICS_TIME_SERIES_QUERY_KEYS, authorization, 'time-series');
  }

  async groups(raw: Record<string, unknown>, authorization: ObservabilityAuthorization) {
    return this.read(raw, STATISTICS_GROUPS_QUERY_KEYS, authorization, 'groups');
  }

  private async read(raw: Record<string, unknown>, keys: readonly string[], authorization: ObservabilityAuthorization,
    mode: StatisticsMode) {
    const { filter } = parseObservabilityQuery(raw, keys);
    if (!filter.scope) throw new ObservabilityApiError('INVALID_QUERY', 'scope');
    if (mode === 'time-series' && !filter.interval) throw new ObservabilityApiError('INVALID_QUERY', 'interval');
    const groupBy = filter.groupBy === undefined ? [] :
      (Array.isArray(filter.groupBy) ? filter.groupBy.map(String) : String(filter.groupBy).split(','));
    if (mode === 'groups' && (!groupBy.length || groupBy.length > 2 || new Set(groupBy).size !== groupBy.length ||
      groupBy.some(dimension => !(STATISTICS_GROUP_DIMENSIONS as readonly string[]).includes(dimension)))) {
      throw new ObservabilityApiError('INVALID_QUERY', 'groupBy');
    }
    return this.store.readSnapshot(async tx => {
      const query = tx.manager.getRepository(RuntimeInvocationRevisionEntity).createQueryBuilder('inv')
        .leftJoinAndMapOne('inv.metricSource', RuntimeAccessSourceEntity, 'source',
          'source.sourceId = inv.sourceId AND (source.runtimeAssetId = inv.runtimeAssetId OR ' +
          '(source.runtimeAssetId IS NULL AND inv.runtimeAssetId IS NULL))')
        .select(['inv', 'source.sourceId', 'source.ipSource'])
        .where('inv.validFromSequence <= :snapshot', { snapshot: sequenceKey(tx.snapshotSeq) })
        .andWhere('(inv.validUntilSequence IS NULL OR inv.validUntilSequence > :snapshot)')
        .andWhere('inv.expiresAt > :now', { now: tx.now })
        .andWhere('inv.origin = :origin', { origin: filter.origin });
      const assets = intersectObservabilityAssets(authorization,
        filter.runtimeAssetId === undefined ? undefined : [String(filter.runtimeAssetId)]);
      if (assets !== null) {
        if (!assets.length) query.andWhere('1 = 0');
        else query.andWhere('inv.runtimeAssetId IN (:...assets)', { assets: [...assets] });
      }
      const kinds = { business: ['gateway_request', 'mcp_tool'], http_ingress: ['gateway_request', 'mcp_protocol'],
        tool: ['mcp_tool'], protocol: ['mcp_protocol'], upstream: ['upstream_api'] }[String(filter.scope)]!;
      query.andWhere('inv.spanKind IN (:...kinds)', { kinds });
      if (filter.scope === 'http_ingress') {
        query.andWhere("(inv.spanKind = 'gateway_request' OR " + this.jsonText(tx.manager, 'transport') +
          ' IN (:...httpTransports))', { httpTransports: ['http', 'sse', 'streamable', 'streamable-http'] });
      }
      const basis = filter.timeBasis === 'completedAt' ? 'completedAt' : 'startedAt';
      query.andWhere('inv.' + basis + ' >= :from AND inv.' + basis + ' < :to', { from: filter.from, to: filter.to });
      for (const key of COLUMNS) {
        if (filter[key] !== undefined) query.andWhere('inv.' + key + ' = :' + key, { [key]: filter[key] });
      }
      for (const key of ['requestId', 'errorCategory'] as const) {
        if (filter[key] !== undefined) query.andWhere(this.jsonText(tx.manager, key) + ' = :' + key, { [key]: filter[key] });
      }
      if (filter.callerId !== undefined) {
        query.andWhere(this.jsonText(tx.manager, 'identitySource') + ' = :authenticated', { authenticated: 'authenticated' })
          .andWhere(this.jsonText(tx.manager, 'authState') + ' = :authenticated');
      }
      const rows = await query.orderBy('inv.invocationId', 'ASC').limit(MAX_METRIC_OBSERVATIONS + 1).getMany() as Row[];
      if (rows.length > MAX_METRIC_OBSERVATIONS) throw new ObservabilityApiError('QUERY_TOO_LARGE', 'from');
      const result = this.aggregate(rows, filter);
      const common: ObservabilityStatisticsSummaryDto = { ...result,
        queryMode: 'retained_invocation_snapshot', maxQueryInvocations: MAX_METRIC_OBSERVATIONS, livenessEvaluated: false };
      let data: ObservabilityStatisticsSummaryDto | ObservabilityStatisticsTimeSeriesDto | ObservabilityStatisticsGroupsDto = common;
      if (mode === 'time-series') data = this.makeTimeSeries(rows, filter, common, String(tx.snapshotSeq));
      if (mode === 'groups') data = this.makeGroups(rows, filter, groupBy, common);
      return observabilitySuccess(data, { snapshotSeq: tx.snapshotSeq, dataWatermark: tx.snapshotSeq,
        lagMs: null, historyCompleteSince: null, isPartial: true });
    });
  }

  private aggregate(rows: Row[], filter: ObservabilityFilter) {
    const window = Object.fromEntries(['from', 'to', 'timeBasis', 'scope', 'origin'].map(key => [key, filter[key]]));
    const result = calculateObservabilityMetrics(rows.map(row => ({
      revision: row.recordVersion, invocation: row.record as CanonicalInvocation,
      sourceId: row.metricSource?.sourceId || null, sourceOverflow: row.metricSource?.ipSource === 'overflow',
      // No heartbeat read is performed: unfinished producers remain explicitly unverified.
    })), window);
    for (const group of result.metrics.byteGroups) {
      group.measurementStage = String(redactAuditValue(group.measurementStage)).replace(/[\u0000-\u001f\u007f]/g, '');
    }
    return result;
  }

  private makeTimeSeries(rows: Row[], filter: ObservabilityFilter, common: ObservabilityStatisticsSummaryDto,
    dataWatermark: string): ObservabilityStatisticsTimeSeriesDto {
    const interval = String(filter.interval) as keyof typeof STATISTICS_INTERVALS;
    const width = STATISTICS_INTERVALS[interval];
    const from = Date.parse(String(filter.from));
    const to = Date.parse(String(filter.to));
    const first = Math.floor(from / width) * width;
    const count = Math.ceil(to / width) - Math.floor(from / width);
    if (count > MAX_STATISTICS_BUCKETS) throw new ObservabilityApiError('QUERY_TOO_LARGE', 'interval');
    const byBucket = new Map<number, Row[]>();
    const basis = filter.timeBasis === 'completedAt' ? 'completedAt' : 'startedAt';
    for (const row of rows) {
      const at = Date.parse(String(row[basis]));
      const start = Math.floor(at / width) * width;
      const selected = byBucket.get(start);
      if (selected) selected.push(row);
      else byBucket.set(start, [row]);
    }
    const items: ObservabilityStatisticsBucketDto[] = [];
    for (let index = 0; index < count; index++) {
      const start = first + index * width;
      const selected = byBucket.get(start) || [];
      if (!selected.length && filter.fill !== 'zero') continue;
      const effectiveFrom = new Date(Math.max(from, start)).toISOString();
      const effectiveTo = new Date(Math.min(to, start + width)).toISOString();
      const result = this.aggregate(selected, { ...filter, from: effectiveFrom, to: effectiveTo });
      items.push({ bucketStart: new Date(start).toISOString(), bucketEnd: new Date(start + width).toISOString(),
        effectiveFrom, effectiveTo, bucketVersion: null, dataWatermark, synthetic: selected.length === 0,
        metrics: result.metrics, coverage: result.coverage });
    }
    return { ...common, interval, fill: String(filter.fill || 'none'), maxBuckets: MAX_STATISTICS_BUCKETS,
      bucketVersionSemantics: 'not_persisted', items };
  }

  private makeGroups(rows: Row[], filter: ObservabilityFilter, groupBy: string[],
    common: ObservabilityStatisticsSummaryDto): ObservabilityStatisticsGroupsDto {
    const groups = new Map<string, { dimensionValues: Record<string, string | null>; rows: Row[] }>();
    for (const row of rows) {
      const dimensionValues = Object.fromEntries(groupBy.map(dimension => {
        const record = row.record as CanonicalInvocation;
        const trustedCaller = record.identitySource === 'authenticated' && record.authState === 'authenticated';
        const value = dimension === 'callerId' && !trustedCaller ? null : row[dimension as typeof STATISTICS_GROUP_DIMENSIONS[number]];
        return [dimension, value === undefined || value === null ? null : String(value)];
      }));
      const key = JSON.stringify(groupBy.map(dimension => dimensionValues[dimension]));
      const existing = groups.get(key);
      if (existing) existing.rows.push(row);
      else groups.set(key, { dimensionValues, rows: [row] });
    }
    const orderBy = String(filter.orderBy || 'selectedInvocations') as typeof STATISTICS_GROUP_ORDER_BY[number];
    const top = Number(filter.top || 20);
    const ranked = [...groups.entries()].map(([key, group]) => ({
      key, dimensionValues: group.dimensionValues, metrics: this.aggregate(group.rows, filter).metrics,
    })).sort((left, right) => right.metrics[orderBy] - left.metrics[orderBy] ||
      (left.key < right.key ? -1 : left.key > right.key ? 1 : 0));
    return { ...common, groupBy, orderBy, top, totalGroups: ranked.length, hasMoreGroups: ranked.length > top,
      items: ranked.slice(0, top).map(({ dimensionValues, metrics }, index) => ({ rank: index + 1, dimensionValues, metrics })) };
  }

  private jsonText(manager: EntityManager, key: 'transport' | 'requestId' | 'errorCategory' | 'identitySource' | 'authState'): string {
    const type = manager.connection.options.type;
    if (type === 'postgres') return "inv.record ->> '" + key + "'";
    if (type === 'sqljs' || type === 'sqlite') return "json_extract(inv.record, '$." + key + "')";
    throw new ObservabilityApiError('OBSERVABILITY_UNAVAILABLE');
  }
}
