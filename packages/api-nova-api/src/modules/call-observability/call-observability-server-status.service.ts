import { sequenceKey } from './call-observability-storage';
import { In } from 'typeorm';
import {
  MANAGED_PROCESS_LIFECYCLE_PREFIX,
  managedProcessLifecycleView,
} from './managed-process-lifecycle-evidence.service';
import { gatewayRoutingView, GATEWAY_ROUTING_OBSERVATION_PREFIX } from './call-observability-gateway-routing.dto';
import { managementHeartbeatView } from './call-observability-heartbeat.dto';
import { MANAGEMENT_HEARTBEAT_ID } from './call-observability-heartbeat.worker';
import { RuntimeInvocationEntity, RuntimeInvocationRevisionEntity, RuntimePipelineStateEntity } from '../../database/entities/runtime-call-observability.entity';
import { Injectable } from '@nestjs/common';
import { RuntimeAssetEntity, RuntimeAssetType, RuntimeAssetStatus } from '../../database/entities/runtime-asset.entity';
import { RuntimeObservabilityStateEntity, RuntimeObservabilityScopeType, RuntimeCurrentStatus,
  RuntimeHealthStatus } from '../../database/entities/runtime-observability-state.entity';
import { ObservabilityAuthorization, intersectObservabilityAssets } from './call-observability-access';
import { ObservabilityApiError, observabilitySuccess } from './call-observability-api.contract';
import { MAX_METRIC_OBSERVATIONS } from './call-observability-metrics';
import { CallObservabilityStore, ObservabilityReadTransaction } from './call-observability.store';
import { ObservabilityFilter } from './call-observability-query';
import { overviewFilter, overviewWindow, OverviewRow, readOverviewRows } from './call-observability-overview-query';
import { ObservabilityPersistedInFlightDto, ObservabilityServerStatusesDto } from './call-observability-server-status.dto';

export const MAX_OBSERVABILITY_STATUS_SERVERS = 200;
export const MAX_OBSERVABILITY_STATUS_ROWS = 5000;
function timestamp(value: unknown): string | null {
  if (!(typeof value === 'string' || value instanceof Date)) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
function status(value: string, allowed: object): string {
  return Object.values(allowed).includes(value) ? value : 'unknown';
}
@Injectable()
export class CallObservabilityServerStatusService {
  constructor(private readonly store: CallObservabilityStore) {}
  async list(raw: Record<string, unknown>, authorization: ObservabilityAuthorization) {
    const filter = overviewFilter(raw);
    return this.store.readSnapshot(async tx => {
      const rows = await readOverviewRows(tx, filter, authorization);
      const data = await this.readInSnapshot(tx, filter, authorization, rows);
      return observabilitySuccess(data, { snapshotSeq: tx.snapshotSeq,
        lagMs: null, historyCompleteSince: null, isPartial: true });
    });
  }
  async readInSnapshot(tx: ObservabilityReadTransaction, filter: ObservabilityFilter,
    authorization: ObservabilityAuthorization, rows: OverviewRow[]): Promise<ObservabilityServerStatusesDto> {
    const assets = intersectObservabilityAssets(authorization,
      filter.runtimeAssetId === undefined ? undefined : [String(filter.runtimeAssetId)]);
    const result: ObservabilityServerStatusesDto = {
      managementHeartbeat: authorization.runtimeAssetIds === null ? managementHeartbeatView(
        await tx.manager.getRepository(RuntimePipelineStateEntity).findOneBy({ id: MANAGEMENT_HEARTBEAT_ID }), Date.parse(tx.now), tx.snapshotSeq) : null,
      window: overviewWindow(filter), items: [], maxServers: MAX_OBSERVABILITY_STATUS_SERVERS,
      coverage: { scope: 'authorized_assets_and_selected_business_invocations', registeredServers: 0,
        serversWithBusinessObservations: 0, serversWithReportedState: 0, unrepresentedBusinessServers: 0,
        unattributedBusinessInvocations: 0, historyCompleteSince: null,
        gaps: ['heartbeat_unavailable', 'history_coverage_unknown'], isPartial: true },
      maxStateRows: MAX_OBSERVABILITY_STATUS_ROWS, maxQueryInvocations: MAX_METRIC_OBSERVATIONS,
      stateBasis: 'current_database_snapshot', dataWatermark: null, invocationDataWatermark: tx.snapshotSeq,
      readAt: tx.now, livenessEvaluated: false, isPartial: true, restricted: authorization.runtimeAssetIds !== null,
    };
    if (assets !== null && !assets.length) return result;
    const query = tx.manager.getRepository(RuntimeAssetEntity).createQueryBuilder('asset')
      .select(['asset.id', 'asset.type', 'asset.status', 'asset.updatedAt'])
      .where('asset.type IN (:...types)', { types: filter.serverType ?
        [filter.serverType === 'gateway' ? RuntimeAssetType.GATEWAY_SERVICE : RuntimeAssetType.MCP_SERVER] :
        [RuntimeAssetType.GATEWAY_SERVICE, RuntimeAssetType.MCP_SERVER] });
    if (assets !== null) query.andWhere('asset.id IN (:...assets)', { assets: [...assets] });
    const records = await query.orderBy('asset.id', 'ASC').limit(MAX_OBSERVABILITY_STATUS_SERVERS + 1).getMany();
    if (records.length > MAX_OBSERVABILITY_STATUS_SERVERS) throw new ObservabilityApiError('QUERY_TOO_LARGE', 'runtimeAssetId');
    // Directory coverage is independent of retained traffic coverage. Deletion or a type change
    // must not silently hide authorized business evidence from this status view.
    const businessRows = rows.filter(row => ['gateway_request', 'mcp_tool'].includes(row.spanKind));
    const serverKey = (id: string, type: string) => JSON.stringify([id, type]);
    const registered = new Set(records.map(asset => serverKey(asset.id,
      asset.type === RuntimeAssetType.GATEWAY_SERVICE ? 'gateway' : 'mcp')));
    const unrepresented = new Set(businessRows.filter(row => row.runtimeAssetId &&
      !registered.has(serverKey(row.runtimeAssetId, row.serverType)))
      .map(row => serverKey(row.runtimeAssetId!, row.serverType)));
    result.coverage.registeredServers = records.length;
    result.coverage.unrepresentedBusinessServers = unrepresented.size;
    result.coverage.unattributedBusinessInvocations = businessRows.filter(row => !row.runtimeAssetId).length;
    if (unrepresented.size) result.coverage.gaps.push('observed_server_not_in_directory');
    if (result.coverage.unattributedBusinessInvocations) result.coverage.gaps.push('business_asset_identity_missing');
    if (!records.length) return result;
    // Legacy nullable unique keys can contain duplicates; choose the newest report deterministically.
    const states = await tx.manager.getRepository(RuntimeObservabilityStateEntity).createQueryBuilder('state')
      .select(['state.id', 'state.runtimeAssetId', 'state.currentStatus', 'state.healthStatus',
        'state.updatedAt', 'state.lastEventAt', 'state.lastSuccessAt', 'state.lastFailureAt'])
      .where('state.runtimeAssetId IN (:...ids)', { ids: records.map(asset => asset.id) })
      .andWhere('state.scopeType = :scope', { scope: RuntimeObservabilityScopeType.RUNTIME_ASSET })
      .andWhere('state.runtimeAssetEndpointBindingId IS NULL')
      .orderBy('state.updatedAt', 'DESC').addOrderBy('state.id', 'DESC')
      .limit(MAX_OBSERVABILITY_STATUS_ROWS + 1).getMany();
    if (states.length > MAX_OBSERVABILITY_STATUS_ROWS) throw new ObservabilityApiError('QUERY_TOO_LARGE', 'runtimeAssetId');
    const latest = new Map<string, RuntimeObservabilityStateEntity>();
    for (const state of states) if (!latest.has(state.runtimeAssetId)) latest.set(state.runtimeAssetId, state);
    const routingRows = await tx.manager.getRepository(RuntimePipelineStateEntity).findBy({
      id: In(records.filter(asset => asset.type === RuntimeAssetType.GATEWAY_SERVICE)
        .map(asset => GATEWAY_ROUTING_OBSERVATION_PREFIX + asset.id)),
    });
    const routing = new Map(routingRows.map(row => [row.id, row]));
    const lifecycleRows = await tx.manager.getRepository(RuntimePipelineStateEntity).findBy({
      id: In(records.map(asset => MANAGED_PROCESS_LIFECYCLE_PREFIX + asset.id)),
    });
    const lifecycle = new Map(lifecycleRows.map(row => [row.id, row]));
    const persisted = await this.readPersistedInFlight(tx, filter, records);
    result.items = records.map(asset => {
      const serverType = asset.type === RuntimeAssetType.GATEWAY_SERVICE ? 'gateway' : 'mcp';
      const business = rows.filter(row => row.runtimeAssetId === asset.id && row.serverType === serverType &&
        ['gateway_request', 'mcp_tool'].includes(row.spanKind));
      const completed = business.map(row => row.record).filter(row =>
        row.phase === 'finished' && row.completionSource === 'observed');
      const last = (outcomes: string[]) => completed.filter(row => outcomes.includes(row.outcome))
        .map(row => timestamp(row.completedAt)).filter((value): value is string => value !== null).sort().pop() || null;
      const state = latest.get(asset.id);
      const managedProcessLifecycle = managedProcessLifecycleView(
        lifecycle.get(MANAGED_PROCESS_LIFECYCLE_PREFIX + asset.id), asset.id);
      return { runtimeAssetId: asset.id, serverType, lifecycleStatus: status(asset.status, RuntimeAssetStatus),
        managedProcessLifecycle,
        persistedInFlight: persisted.get(asset.id)!,
        managedLifecycleHistory: {
          source: 'runtime_pipeline_states', scope: 'latest_generation_only', dataWatermark: null, historyComplete: false,
          status: managedProcessLifecycle ? 'observed' : lifecycle.has(MANAGED_PROCESS_LIFECYCLE_PREFIX + asset.id) ? 'unavailable' : 'unknown',
          reason: managedProcessLifecycle ? null : lifecycle.has(MANAGED_PROCESS_LIFECYCLE_PREFIX + asset.id) ? 'invalid_lifecycle_evidence' : 'lifecycle_evidence_missing',
          generation: managedProcessLifecycle?.generation ?? null, startedAt: managedProcessLifecycle?.startedAt ?? null,
          terminalAt: managedProcessLifecycle && managedProcessLifecycle.observedEvent !== 'started' ? managedProcessLifecycle.observedAt : null,
          terminalEvent: managedProcessLifecycle && managedProcessLifecycle.observedEvent !== 'started' ? managedProcessLifecycle.observedEvent : null,
        },
        lifecycleSource: 'runtime_assets', lifecycleUpdatedAt: timestamp(asset.updatedAt),
        gatewayRoutingObservation: serverType === 'gateway' ? gatewayRoutingView(
          routing.get(GATEWAY_ROUTING_OBSERVATION_PREFIX + asset.id) ?? null, asset.id, Date.parse(tx.now), tx.snapshotSeq) : null,
        healthStatus: 'unknown', dependencyHealth: 'unknown', freshnessStatus: 'unknown',
        lastHeartbeatAt: null, processInstanceId: managedProcessLifecycle?.generation ?? null,
        activeInvocations: null, stateVersion: managedProcessLifecycle ? String(managedProcessLifecycle.stateVersion) : null,
        unknownInFlight: business.filter(row => row.record.phase !== 'finished').length,
        observedBusinessRequests: business.length, businessObservationStatus: business.length ? 'observed' : 'not_observed',
        lastSuccessAt: last(['success']),
        lastFailureAt: last(['error', 'timeout', 'incomplete']),
        reportedState: state ? { source: 'runtime_observability_states',
          lifecycleStatus: status(state.currentStatus, RuntimeCurrentStatus),
          healthStatus: status(state.healthStatus, RuntimeHealthStatus),
          updatedAt: timestamp(state.updatedAt), lastEventAt: timestamp(state.lastEventAt),
          lastSuccessAt: timestamp(state.lastSuccessAt), lastFailureAt: timestamp(state.lastFailureAt) } : null,
      };
    });
    result.coverage.serversWithBusinessObservations = result.items.filter(item => item.observedBusinessRequests > 0).length;
    result.coverage.serversWithReportedState = result.items.filter(item => item.reportedState !== null).length;
    if (result.coverage.serversWithBusinessObservations < records.length) result.coverage.gaps.push('business_not_observed');
    if (result.coverage.serversWithReportedState < records.length) result.coverage.gaps.push('persisted_state_missing');
    if (result.items.some(item => item.persistedInFlight.status !== 'observed')) result.coverage.gaps.push('in_flight_evidence_incomplete');
    if (result.items.some(item => item.managedLifecycleHistory.status !== 'observed')) result.coverage.gaps.push('managed_lifecycle_evidence_missing');
    return result;
  }

  private async readPersistedInFlight(tx: ObservabilityReadTransaction, filter: ObservabilityFilter,
    assets: RuntimeAssetEntity[]): Promise<Map<string, ObservabilityPersistedInFlightDto>> {
    const output = new Map<string, ObservabilityPersistedInFlightDto>();
    const base = { source: 'runtime_invocation_revisions', dataWatermark: tx.snapshotSeq, origin: String(filter.origin),
      timeScope: 'all_retained_starts', livenessEvaluated: false, coverage: 'unknown' };
    for (const asset of assets) output.set(asset.id, { ...base, status: 'unknown', count: null, reason: 'retained_business_evidence_missing' });
    if (!tx.manager.connection.hasMetadata(RuntimeInvocationRevisionEntity)) {
      for (const asset of assets) output.set(asset.id, { ...base, status: 'unavailable', count: null, reason: 'invocation_revision_store_unavailable' });
      return output;
    }
    const snapshot = sequenceKey(tx.snapshotSeq), ids = assets.map(asset => asset.id);
    // Aggregate in the database: finished retained history must not turn status
    // into a 5000-row sample or make an otherwise bounded asset query fail.
    const revisions = await tx.manager.getRepository(RuntimeInvocationRevisionEntity).createQueryBuilder('inv')
      .select('inv.runtimeAssetId', 'runtimeAssetId').addSelect('inv.serverType', 'serverType')
      .addSelect('COUNT(*)', 'total').addSelect('COUNT(DISTINCT inv.invocationId)', 'distinctCount')
      .addSelect("SUM(CASE WHEN inv.phase = 'started' THEN 1 ELSE 0 END)", 'unfinished')
      .addSelect("SUM(CASE WHEN inv.phase NOT IN ('started', 'finished') THEN 1 ELSE 0 END)", 'invalid')
      .where('inv.runtimeAssetId IN (:...ids)', { ids })
      .andWhere('inv.serverType IN (:...serverTypes)', { serverTypes: ['gateway', 'mcp'] })
      .andWhere('inv.validFromSequence <= :snapshot AND (inv.validUntilSequence IS NULL OR inv.validUntilSequence > :snapshot)', { snapshot })
      .andWhere('inv.expiresAt > :now AND inv.startedAt <= :now', { now: tx.now })
      .andWhere('inv.origin = :origin', { origin: filter.origin })
      .andWhere('inv.spanKind IN (:...kinds)', { kinds: ['gateway_request', 'mcp_tool'] })
      .groupBy('inv.runtimeAssetId').addGroupBy('inv.serverType').getRawMany();
    const missing = tx.manager.connection.hasMetadata(RuntimeInvocationEntity)
      ? await tx.manager.getRepository(RuntimeInvocationEntity).createQueryBuilder('inv')
        .leftJoin(RuntimeInvocationRevisionEntity, 'history',
          'history.invocationId = inv.invocationId AND history.runtimeAssetId = inv.runtimeAssetId AND history.serverType = inv.serverType AND history.validFromSequence <= :snapshot AND (history.validUntilSequence IS NULL OR history.validUntilSequence > :snapshot) AND history.expiresAt > :now', { snapshot, now: tx.now })
        .select('inv.runtimeAssetId', 'runtimeAssetId').addSelect('inv.serverType', 'serverType')
        .addSelect('COUNT(*)', 'total')
        .where('inv.runtimeAssetId IN (:...ids)', { ids })
        .andWhere('inv.serverType IN (:...serverTypes)', { serverTypes: ['gateway', 'mcp'] })
        .andWhere('inv.createdSequence <= :snapshot', { snapshot })
        .andWhere('inv.expiresAt > :now AND inv.startedAt <= :now', { now: tx.now })
        .andWhere('inv.origin = :origin', { origin: filter.origin })
        .andWhere('inv.spanKind IN (:...kinds)', { kinds: ['gateway_request', 'mcp_tool'] })
        .andWhere('history.id IS NULL').groupBy('inv.runtimeAssetId').addGroupBy('inv.serverType').getRawMany() : [];
    for (const asset of assets) {
      const serverType = asset.type === RuntimeAssetType.GATEWAY_SERVICE ? 'gateway' : 'mcp';
      const evidence = revisions.find(row => row.runtimeAssetId === asset.id && row.serverType === serverType);
      const missingHistory = missing.some(row => row.runtimeAssetId === asset.id && row.serverType === serverType);
      const numbers = evidence && [evidence.total, evidence.distinctCount, evidence.unfinished, evidence.invalid].map(Number);
      const invalid = numbers && (numbers.some(value => !Number.isSafeInteger(value) || value < 0) || numbers[0] !== numbers[1] || numbers[3] > 0);
      if (missingHistory || invalid) {
        output.set(asset.id, { ...base, status: 'unavailable', count: null, reason: missingHistory ? 'snapshot_revision_evidence_missing' : 'invalid_invocation_revision_evidence' });
      } else if (evidence) output.set(asset.id, { ...base, status: 'observed', count: Number(evidence.unfinished), reason: null });
    }
    return output;
  }
}
