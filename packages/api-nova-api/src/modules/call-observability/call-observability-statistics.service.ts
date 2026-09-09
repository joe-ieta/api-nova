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
import { ObservabilityStatisticsSummaryDto } from './call-observability-statistics.dto';

export const STATISTICS_SCOPES = ['business', 'http_ingress', 'tool', 'protocol', 'upstream'] as const;
export const STATISTICS_SUMMARY_QUERY_KEYS = ['from', 'to', 'timeBasis', 'origin', 'scope', 'serverType',
  'runtimeAssetId', 'callerId', 'sourceId', 'endpointDefinitionId', 'toolName', 'sourceServiceInstanceId',
  'spanKind', 'outcome', 'traceId', 'requestId', 'errorCategory'] as const;
const COLUMNS = ['serverType', 'callerId', 'sourceId', 'endpointDefinitionId', 'toolName',
  'sourceServiceInstanceId', 'spanKind', 'outcome', 'traceId'] as const;
type Row = RuntimeInvocationRevisionEntity & { metricSource?: Pick<RuntimeAccessSourceEntity, 'sourceId' | 'ipSource'> };

@Injectable()
export class CallObservabilityStatisticsService {
  constructor(private readonly store: CallObservabilityStore) {}

  async summary(raw: Record<string, unknown>, authorization: ObservabilityAuthorization) {
    const { filter } = parseObservabilityQuery(raw, STATISTICS_SUMMARY_QUERY_KEYS);
    if (!filter.scope) throw new ObservabilityApiError('INVALID_QUERY', 'scope');
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
      const window = Object.fromEntries(['from', 'to', 'timeBasis', 'scope', 'origin'].map(key => [key, filter[key]]));
      const result = calculateObservabilityMetrics(rows.map(row => ({
        revision: row.recordVersion, invocation: row.record as CanonicalInvocation,
        sourceId: row.metricSource?.sourceId || null, sourceOverflow: row.metricSource?.ipSource === 'overflow',
        // No heartbeat read is performed: unfinished producers remain explicitly unverified.
      })), window);
      for (const group of result.metrics.byteGroups) {
        group.measurementStage = String(redactAuditValue(group.measurementStage)).replace(/[\u0000-\u001f\u007f]/g, '');
      }
      const data: ObservabilityStatisticsSummaryDto = { ...result,
        queryMode: 'retained_invocation_snapshot', maxQueryInvocations: MAX_METRIC_OBSERVATIONS, livenessEvaluated: false };
      return observabilitySuccess(data, { snapshotSeq: tx.snapshotSeq, dataWatermark: tx.snapshotSeq,
        lagMs: null, historyCompleteSince: null, isPartial: true });
    });
  }

  private jsonText(manager: EntityManager, key: 'transport' | 'requestId' | 'errorCategory' | 'identitySource' | 'authState'): string {
    const type = manager.connection.options.type;
    if (type === 'postgres') return "inv.record ->> '" + key + "'";
    if (type === 'sqljs' || type === 'sqlite') return "json_extract(inv.record, '$." + key + "')";
    throw new ObservabilityApiError('OBSERVABILITY_UNAVAILABLE');
  }
}
