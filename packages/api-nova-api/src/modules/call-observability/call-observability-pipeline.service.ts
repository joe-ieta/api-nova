import { managementHeartbeatView } from './call-observability-heartbeat.dto';
import { MANAGEMENT_HEARTBEAT_ID } from './call-observability-heartbeat.worker';
import { retentionPipelineView } from './call-observability-pipeline-retention';
import { RETENTION_WORKER_ID, RETENTION_ERROR_CODES } from './call-observability-retention.worker';
import { Injectable } from '@nestjs/common';
import { RuntimeObservabilityEventEntity } from '../../database/entities/runtime-observability-event.entity';
import { OUTBOX_WORKER_STATE_ID } from './call-observability-outbox.service';
import { WEBHOOK_WORKER_ID } from './call-observability-delivery.worker';
import { sequenceKey } from './call-observability-storage';
import { RuntimeMetricBucketEntity, RuntimeCallerBucketEntity, RuntimePipelineStateEntity } from '../../database/entities/runtime-call-observability.entity';
import { ObservabilityAuthorization, requireGlobalObservabilityScope } from './call-observability-access';
import { ObservabilityApiError, observabilitySuccess } from './call-observability-api.contract';
import { ObservabilityPipelineAggregationDto, ObservabilityPipelineDispatchDto, ObservabilityPipelineIngestDto, ObservabilityPipelineStageDto } from './call-observability-pipeline.dto';
import { CallObservabilityStore } from './call-observability.store';
import { COLLECTOR_WORKER_ID } from './call-observability.worker';

export const PIPELINE_OBSERVATION_STALE_AFTER_MS = 15000;
const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const count = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
const timestamp = (value: unknown, now: number): string | null => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) && time <= now && new Date(time).toISOString() === value ? value : null;
};
const unmeasured = (state: string): ObservabilityPipelineStageDto => ({
  state, dataWatermark: null, lagMs: null, pendingCount: null, oldestPendingAt: null,
  failedRecords: null, quarantinedRecords: null, quarantinedRecordsScope: null,
  droppedRecords: null, unknownLoss: null, diskUsage: null, effectiveQuota: null, gapRanges: null,
});

@Injectable()
export class CallObservabilityPipelineService {
  constructor(private readonly store: CallObservabilityStore) {}
  async get(raw: Record<string, unknown>, authorization: ObservabilityAuthorization) {
    // Reject local scopes before reading any global evidence, including the snapshot sequence.
    if (!authorization) throw new ObservabilityApiError('UNAUTHENTICATED');
    if (!authorization.requiredPermissions.includes('monitoring:read')) throw new ObservabilityApiError('FORBIDDEN');
    requireGlobalObservabilityScope(authorization);
    if (!object(raw) || Object.keys(raw).length) throw new ObservabilityApiError('INVALID_QUERY', 'query');
    return this.store.readSnapshot(async tx => {
      const row = await tx.manager.getRepository(RuntimePipelineStateEntity).findOneBy({ id: COLLECTOR_WORKER_ID });
      const value = object(row?.value), scan = object(value?.scan), now = Date.parse(tx.now);
      const observedAt = timestamp(row?.updatedAt, now);
      const observationAgeMs = observedAt === null ? null : now - Date.parse(observedAt);
      const lastSuccessfulScanAt = timestamp(value?.lastSuccessfulScanAt, observedAt ? Date.parse(observedAt) : now);
      const successfulScanAgeMs = lastSuccessfulScanAt === null ? null : now - Date.parse(lastSuccessfulScanAt);
      const scanComplete = typeof value?.scanComplete === 'boolean' ? value.scanComplete : null;
      const state = ['running', 'waiting_for_source', 'degraded'].includes(String(value?.state))
        ? String(value!.state) : 'unknown';
      const errors = object(scan?.errors);
      const errorCounts = errors ? Object.values(errors).map(count) : null;
      const sum = errorCounts && errorCounts.every(n => n !== null)
        ? errorCounts.reduce<number>((total, n) => total + n!, 0) : null;
      const sequence = value?.snapshotSeq;
      const dataWatermark = typeof sequence === 'string' && /^(0|[1-9]\d{0,19})$/.test(sequence) &&
        BigInt(sequence) <= BigInt(tx.snapshotSeq) ? sequence : null;
      const quarantinedRecords = count(scan?.quarantinedRecords);
      const ingest: ObservabilityPipelineIngestDto = {
        ...unmeasured(state), dataWatermark,
        freshnessStatus: observationAgeMs === null ? 'unknown' :
          observationAgeMs > PIPELINE_OBSERVATION_STALE_AFTER_MS ? 'stale' : 'recent',
        staleAfterMs: PIPELINE_OBSERVATION_STALE_AFTER_MS, observedAt, observationAgeMs,
        lastSuccessfulScanAt, successfulScanAgeMs, scanComplete,
        scanStartedAt: timestamp(scan?.startedAt, observedAt ? Date.parse(observedAt) : now),
        backlogScope: scanComplete === null ? null : scanComplete ? 'completed_directory_scan' : 'partial_directory_scan',
        backlogFiles: count(scan?.backlogFiles), partialBytes: count(scan?.partialBytes),
        scanErrorCount: count(sum), quarantinedRecords,
        quarantinedRecordsScope: quarantinedRecords === null ? null : 'current_scan',
      };
      // Match Store.recomputePendingBuckets: metric AND caller pending JSON markers,
      // including expired rows still selected by that worker. There is no lease/retry protocol.
      const dialect = tx.manager.connection.options.type;
      const pendingPath = dialect === 'postgres' ? "bucket.metrics -> 'recompute' ->> 'state'" :
        ['sqljs', 'sqlite'].includes(dialect) ? "json_extract(bucket.metrics, '$.recompute.state')" : null;
      if (!pendingPath) throw new ObservabilityApiError('OBSERVABILITY_UNAVAILABLE');
      const pendingBuckets = await tx.manager.getRepository(RuntimeMetricBucketEntity).createQueryBuilder('bucket')
        .where(pendingPath + ' = :pending', { pending: 'pending' }).getCount();
      const pendingCallerBuckets = await tx.manager.getRepository(RuntimeCallerBucketEntity).createQueryBuilder('bucket')
        .where(pendingPath + ' = :pending', { pending: 'pending' }).getCount();
      const aggregation: ObservabilityPipelineAggregationDto = {
        ...unmeasured(pendingBuckets + pendingCallerBuckets > 0 ? 'backlog' : 'unknown'),
        evidenceSource: 'store_metrics_recompute_markers',
        pendingCountScope: 'all_persisted_metric_and_caller_pending_markers_including_expired',
        pendingCount: pendingBuckets + pendingCallerBuckets, pendingBuckets, pendingCallerBuckets,
        lastRunRecomputedBuckets: count(value?.recomputedBuckets),
        lastRunRecomputeFailures: count(value?.recomputeFailures), countsObservedAt: tx.now,
      };
      const states = tx.manager.getRepository(RuntimePipelineStateEntity);
      const managementHeartbeat = managementHeartbeatView(await states.findOneBy({ id: MANAGEMENT_HEARTBEAT_ID }), now, tx.snapshotSeq);
      const outbox = await states.findOneBy({ id: OUTBOX_WORKER_STATE_ID });
      const webhook = await states.findOneBy({ id: WEBHOOK_WORKER_ID });
      const outboxValue = object(outbox?.value), webhookValue = object(webhook?.value);
      const watermark = (input: unknown): string | null =>
        typeof input === 'string' && /^\d{1,20}$/.test(input) &&
        BigInt(input) <= BigInt(tx.snapshotSeq) ? BigInt(input).toString() : null;
      const outboxWatermark = watermark(outboxValue?.watermark);
      const outboxObservedAt = timestamp(outbox?.updatedAt, now);
      const outboxAge = outboxObservedAt === null ? null : now - Date.parse(outboxObservedAt);
      const eventRepository = tx.manager.getRepository(RuntimeObservabilityEventEntity);
      const expiresColumn = eventRepository.metadata.findColumnWithPropertyName('expiresAt')!;
      const eventNow = tx.manager.connection.driver.preparePersistentValue(new Date(tx.now), expiresColumn);
      // Actual outstanding materialization jobs, independent of whether the worker ever ran.
      // Suppressed/materialized/expired/unversioned events are outside this worker's domain.
      const pendingEvents = await eventRepository.createQueryBuilder('event')
        .where('event.schemaVersion = :schema', { schema: '1.0' })
        .andWhere('event.sequence IS NOT NULL AND event.sequence <= :snapshot', { snapshot: sequenceKey(tx.snapshotSeq) })
        .andWhere("event.dispatchState IN (:...states)", { states: ['pending', 'leased'] })
        .andWhere('event.expiresAt > :now', { now: eventNow }).getCount();
      const webhookObservedAt = timestamp(webhook?.updatedAt, now);
      const webhookAge = webhookObservedAt === null ? null : now - Date.parse(webhookObservedAt);
      const dispatch: ObservabilityPipelineDispatchDto = {
        ...unmeasured(pendingEvents > 0 ? 'backlog' : 'unknown'),
        evidenceSource: 'outbox_materializer_state_and_pending_events',
        dataWatermark: outboxWatermark,
        dataWatermarkScope: 'outbox_materialization_not_webhook_acknowledgement',
        pendingCountScope: 'unexpired_schema_1_events_pending_or_leased_through_snapshot',
        pendingCount: pendingEvents, observedAt: outboxObservedAt, observationAgeMs: outboxAge,
        freshnessStatus: outboxAge === null ? 'unknown' :
          outboxAge > PIPELINE_OBSERVATION_STALE_AFTER_MS ? 'stale' : 'recent',
        staleAfterMs: PIPELINE_OBSERVATION_STALE_AFTER_MS, countsObservedAt: tx.now,
        lastReconciledAt: timestamp(outboxValue?.lastReconciledAt, outboxObservedAt ? Date.parse(outboxObservedAt) : now),
        lastMaterializedAt: timestamp(outboxValue?.lastMaterializedAt, outboxObservedAt ? Date.parse(outboxObservedAt) : now),
        webhook: {
          evidenceSource: 'webhook_worker_last_run',
          state: ['running', 'degraded'].includes(String(webhookValue?.state)) ? String(webhookValue.state) : 'unknown',
          observedAt: webhookObservedAt, observationAgeMs: webhookAge,
          freshnessStatus: webhookAge === null ? 'unknown' :
            webhookAge > PIPELINE_OBSERVATION_STALE_AFTER_MS ? 'stale' : 'recent',
          staleAfterMs: PIPELINE_OBSERVATION_STALE_AFTER_MS,
          snapshotSeq: watermark(webhookValue?.snapshotSeq),
          workerConfigured: typeof webhookValue?.workerConfigured === 'boolean' ? webhookValue.workerConfigured : null,
          lastAttemptAt: timestamp(webhookValue?.lastAttemptAt, webhookObservedAt ? Date.parse(webhookObservedAt) : now),
          claimed: count(webhookValue?.claimed), succeeded: count(webhookValue?.succeeded),
          retrying: count(webhookValue?.retrying), dead: count(webhookValue?.dead), cancelled: count(webhookValue?.cancelled),
        },
      };
      const retentionRow = await tx.manager.getRepository(RuntimePipelineStateEntity).findOneBy({ id: RETENTION_WORKER_ID });
      const retention = retentionPipelineView(retentionRow, now, RETENTION_ERROR_CODES);
      return observabilitySuccess({ managementHeartbeat, resourceScope: 'global', semantics: 'persisted_observations_not_live_health',
        evaluatedAt: tx.now, ingest, aggregation, dispatch, retention },
      { snapshotSeq: tx.snapshotSeq, lagMs: null, isPartial: true, historyCompleteSince: null });
    });
  }
}
