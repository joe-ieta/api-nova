import { ApiProperty } from '@nestjs/swagger';
import { CanonicalInvocation, redactAuditValue } from 'api-nova-parser';
import { RuntimeAccessSourceEntity, RuntimeInvocationRevisionEntity } from '../../database/entities/runtime-call-observability.entity';
import { ObservabilityAuthorization, intersectObservabilityAssets } from './call-observability-access';
import { ObservabilityApiError } from './call-observability-api.contract';
import { calculateObservabilityMetrics, MAX_METRIC_OBSERVATIONS } from './call-observability-metrics';
import { ObservabilityFilter, parseObservabilityQuery } from './call-observability-query';
import { ObservabilityReadTransaction } from './call-observability.store';
import { sequenceKey } from './call-observability-storage';

export const OBSERVABILITY_OVERVIEW_QUERY_KEYS = ['from', 'to', 'origin', 'serverType', 'runtimeAssetId'] as const;
export class ObservabilityOverviewWindowDto {
  @ApiProperty({ format: 'date-time' }) from: string;
  @ApiProperty({ format: 'date-time' }) to: string;
  @ApiProperty({ enum: ['external', 'test', 'probe', 'internal'] }) origin: string;
  @ApiProperty({ enum: ['startedAt'] }) timeBasis: string;
}
export type OverviewRow = RuntimeInvocationRevisionEntity & {
  metricSource?: Pick<RuntimeAccessSourceEntity, 'sourceId' | 'ipSource'>;
};
export function overviewFilter(raw: Record<string, unknown>): ObservabilityFilter {
  return { ...parseObservabilityQuery(raw, OBSERVABILITY_OVERVIEW_QUERY_KEYS).filter, timeBasis: 'startedAt' };
}
export function overviewWindow(filter: ObservabilityFilter): ObservabilityOverviewWindowDto {
  return { from: String(filter.from), to: String(filter.to), origin: String(filter.origin), timeBasis: 'startedAt' };
}
/** The caller supplies one read transaction; never creates a nested snapshot or reads payloads. */
export async function readOverviewRows(tx: ObservabilityReadTransaction, filter: ObservabilityFilter,
  authorization: ObservabilityAuthorization): Promise<OverviewRow[]> {
  const assets = intersectObservabilityAssets(authorization,
    filter.runtimeAssetId === undefined ? undefined : [String(filter.runtimeAssetId)]);
  if (assets !== null && !assets.length) return [];
  const query = tx.manager.getRepository(RuntimeInvocationRevisionEntity).createQueryBuilder('inv')
    .leftJoinAndMapOne('inv.metricSource', RuntimeAccessSourceEntity, 'source',
      'source.sourceId = inv.sourceId AND (source.runtimeAssetId = inv.runtimeAssetId OR ' +
      '(source.runtimeAssetId IS NULL AND inv.runtimeAssetId IS NULL))')
    .select(['inv', 'source.sourceId', 'source.ipSource'])
    .where('inv.validFromSequence <= :snapshot', { snapshot: sequenceKey(tx.snapshotSeq) })
    .andWhere('(inv.validUntilSequence IS NULL OR inv.validUntilSequence > :snapshot)')
    .andWhere('inv.expiresAt > :now', { now: tx.now })
    .andWhere('inv.origin = :origin', { origin: filter.origin })
    .andWhere('inv.startedAt >= :from AND inv.startedAt < :to', { from: filter.from, to: filter.to })
    .andWhere('inv.spanKind IN (:...kinds)', { kinds: ['gateway_request', 'mcp_tool', 'upstream_api'] });
  if (assets !== null) query.andWhere('inv.runtimeAssetId IN (:...assets)', { assets: [...assets] });
  if (filter.serverType !== undefined) query.andWhere('inv.serverType = :serverType', { serverType: filter.serverType });
  const rows = await query.orderBy('inv.invocationId', 'ASC').limit(MAX_METRIC_OBSERVATIONS + 1).getMany() as OverviewRow[];
  if (rows.length > MAX_METRIC_OBSERVATIONS) throw new ObservabilityApiError('QUERY_TOO_LARGE', 'from');
  return rows;
}
export function overviewSummary(rows: OverviewRow[], filter: ObservabilityFilter, scope: 'business' | 'upstream',
  dataWatermark: string) {
  const result = calculateObservabilityMetrics(rows.map(row => ({ revision: row.recordVersion,
    invocation: row.record as CanonicalInvocation, sourceId: row.metricSource?.sourceId || null,
    sourceOverflow: row.metricSource?.ipSource === 'overflow' })),
  { ...overviewWindow(filter), scope });
  for (const group of result.metrics.byteGroups) {
    group.measurementStage = String(redactAuditValue(group.measurementStage)).replace(/[\u0000-\u001f\u007f]/g, '');
  }
  return { ...result, dataWatermark, queryMode: 'retained_invocation_snapshot' as const,
    maxQueryInvocations: MAX_METRIC_OBSERVATIONS, livenessEvaluated: false };
}
