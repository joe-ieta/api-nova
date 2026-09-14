import { Injectable } from '@nestjs/common';
import { CanonicalInvocation } from 'api-nova-parser';
import { ObservabilityAuthorization } from './call-observability-access';
import { observabilitySuccess } from './call-observability-api.contract';
import { MAX_METRIC_OBSERVATIONS } from './call-observability-metrics';
import { CallObservabilityStore } from './call-observability.store';
import { overviewFilter, overviewWindow, overviewSummary, readOverviewRows, OverviewRow } from './call-observability-overview-query';
import { ObservabilityDependenciesDto } from './call-observability-dependencies.dto';

/** Follow visible parent evidence to the nearest business invocation, not the protocol root. */
function businessRoot(row: CanonicalInvocation, visible: Map<string, CanonicalInvocation>): string | null {
  if (row.origin !== 'external' || !row.runtimeAssetId || !row.traceId) return null;
  const seen = new Set<string>([row.invocationId]);
  let id = row.parentInvocationId;
  while (id && !seen.has(id)) {
    seen.add(id);
    const parent = visible.get(id);
    if (!parent || parent.origin !== row.origin || parent.runtimeAssetId !== row.runtimeAssetId ||
      parent.traceId !== row.traceId) return null;
    if (['gateway_request', 'mcp_tool'].includes(parent.spanKind)) return parent.invocationId;
    id = parent.parentInvocationId;
  }
  return null;
}
@Injectable()
export class CallObservabilityDependenciesService {
  constructor(private readonly store: CallObservabilityStore) {}
  async list(raw: Record<string, unknown>, authorization: ObservabilityAuthorization) {
    const filter = overviewFilter(raw);
    return this.store.readSnapshot(async tx => {
      const rows = await readOverviewRows(tx, filter, authorization);
      const visible = new Map<string, CanonicalInvocation>(rows.map(row => [row.invocationId, row.record]));
      const groups = new Map<string, OverviewRow[]>();
      for (const row of rows) {
        if (row.spanKind !== 'upstream_api') continue;
        const key = JSON.stringify([row.runtimeAssetId, row.serverType, row.endpointDefinitionId, row.sourceServiceInstanceId]);
        const group = groups.get(key) || [];
        group.push(row); groups.set(key, group);
      }
      const items = [...groups.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, group]) => {
        const first = group[0], metrics = overviewSummary(group, filter, 'upstream', tx.snapshotSeq).metrics;
        const failed = group.map(row => row.record as CanonicalInvocation).filter(row =>
          row.phase === 'finished' && ['error', 'timeout', 'incomplete'].includes(row.outcome));
        const affected = new Set<string>();
        let unlinkedFailureRecords = 0;
        for (const row of failed) {
          if (row.origin !== 'external') continue;
          const root = businessRoot(row, visible);
          if (root) affected.add(root); else unlinkedFailureRecords++;
        }
        const times = failed.filter(row => row.completionSource === 'observed' && row.completedAt &&
          Number.isFinite(Date.parse(row.completedAt))).map(row => new Date(row.completedAt).toISOString()).sort();
        return { runtimeAssetId: first.runtimeAssetId, serverType: first.serverType,
          endpointDefinitionId: first.endpointDefinitionId, sourceServiceInstanceId: first.sourceServiceInstanceId,
          upstreamRequests: metrics.upstreamRequests, failures: metrics.failures, retryAttempts: metrics.retryAttempts,
          unlinkedRetryRecords: metrics.unlinkedRetryRecords, affectedBusinessRequests: affected.size,
          unlinkedFailureRecords, relationshipsComplete: unlinkedFailureRecords === 0,
          lastFailureAt: times.pop() || null, dataWatermark: tx.snapshotSeq, isPartial: true };
      });
      const data: ObservabilityDependenciesDto = { window: overviewWindow(filter), items,
        dataWatermark: tx.snapshotSeq, maxQueryInvocations: MAX_METRIC_OBSERVATIONS,
        queryMode: 'retained_invocation_snapshot', historyCompleteSince: null, isPartial: true,
        restricted: authorization.runtimeAssetIds !== null, dependencyBasis: 'observed_upstream_invocations' };
      return observabilitySuccess(data, { snapshotSeq: tx.snapshotSeq, dataWatermark: tx.snapshotSeq,
        lagMs: null, historyCompleteSince: null, isPartial: true });
    });
  }
}
